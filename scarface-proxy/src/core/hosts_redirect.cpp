#include "hosts_redirect.hpp"

#ifdef _WIN32
#include <atomic>
#include <fstream>
#include <sstream>
#include <string>

#include <windows.h>
#include <spdlog/spdlog.h>

namespace core {
namespace {
    constexpr const char* BEGIN_MARK{ "# >>> Scarface Proxy (auto, do not edit) >>>" };
    constexpr const char* END_MARK{ "# <<< Scarface Proxy <<<" };

    // Set once a block has been written, so restore() runs its removal exactly
    // once even when both the console-close handler and the destructor call it.
    std::atomic<bool> g_block_written{ false };

    [[nodiscard]] std::string hosts_path()
    {
        char buf[MAX_PATH]{};
        const UINT n{ GetWindowsDirectoryA(buf, MAX_PATH) };
        const std::string dir{ (n > 0 && n < MAX_PATH) ? std::string{ buf, n } : std::string{ "C:\\Windows" } };
        return dir + "\\System32\\drivers\\etc\\hosts";
    }

    [[nodiscard]] std::string read_file(const std::string& path)
    {
        std::ifstream in{ path, std::ios::binary };
        if (!in) {
            return {};
        }

        std::ostringstream ss{};
        ss << in.rdbuf();
        return ss.str();
    }

    [[nodiscard]] bool write_file(const std::string& path, const std::string& content)
    {
        std::ofstream out{ path, std::ios::binary | std::ios::trunc };
        if (!out) {
            return false;
        }

        out << content;
        return out.good();
    }

    // Returns the hosts content with any Scarface block (ours) removed.
    [[nodiscard]] std::string strip_block(const std::string& content)
    {
        std::istringstream in{ content };
        std::string out{};
        std::string line{};
        bool in_block{ false };

        while (std::getline(in, line)) {
            const bool is_marker{ line.rfind("#", 0) == 0 && line.find("Scarface Proxy") != std::string::npos };
            if (is_marker && line.find(">>>") != std::string::npos) {
                in_block = true;
                continue;
            }
            if (is_marker && line.find("<<<") != std::string::npos) {
                in_block = false;
                continue;
            }
            if (in_block) {
                continue;
            }

            out += line;
            out += '\n';
        }

        return out;
    }

    void flush_dns()
    {
        // Best effort: make the hosts change take effect for new lookups.
        STARTUPINFOA si{};
        si.cb = sizeof(si);
        PROCESS_INFORMATION pi{};
        char cmd[]{ "ipconfig /flushdns" };
        if (CreateProcessA(nullptr, cmd, nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
            WaitForSingleObject(pi.hProcess, 3000);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
    }
}

HostsRedirect::HostsRedirect()
{
    const auto path{ hosts_path() };
    const auto content{ read_file(path) };
    if (content.empty()) {
        spdlog::warn("Could not read the hosts file; Growtopia may not route through the proxy. Run the proxy as administrator.");
        return;
    }

    // Drop any leftover block from a previous crash, then append a fresh one.
    std::string next{ strip_block(content) };
    if (!next.empty() && next.back() != '\n') {
        next += '\n';
    }
    next += BEGIN_MARK;
    next += '\n';
    next += "127.0.0.1 www.growtopia1.com\n";
    next += "127.0.0.1 growtopia1.com\n";
    next += END_MARK;
    next += '\n';

    if (!write_file(path, next)) {
        spdlog::warn("Could not write the hosts file; run the proxy as administrator so Growtopia routes through it.");
        return;
    }

    g_block_written = true;
    active_ = true;
    flush_dns();
    spdlog::info("Growtopia is now routed through the proxy (hosts updated automatically).");
}

void HostsRedirect::restore()
{
    bool expected{ true };
    if (!g_block_written.compare_exchange_strong(expected, false)) {
        return; // nothing written, or already restored
    }

    const auto path{ hosts_path() };
    const auto content{ read_file(path) };
    if (!content.empty()) {
        write_file(path, strip_block(content));
        flush_dns();
        spdlog::info("Restored the hosts file (Growtopia back to normal).");
    }
}

HostsRedirect::~HostsRedirect()
{
    restore();
}
}
#else
namespace core {
HostsRedirect::HostsRedirect() = default;
HostsRedirect::~HostsRedirect() = default;
void HostsRedirect::restore() {}
}
#endif
