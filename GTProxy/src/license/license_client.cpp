#include "license_client.hpp"

#include <array>
#include <chrono>
#include <csignal>
#include <exception>
#include <fstream>
#include <httplib.h>
#include <fmt/format.h>
#include <glaze/glaze.hpp>
#include <openssl/rand.h>

#ifdef _WIN32
#include <windows.h>
#elif defined(__APPLE__)
#include <unistd.h>
#include <uuid/uuid.h>
#endif

namespace license {
namespace {
struct ActivateRequest {
    std::string key;
    std::string hwid;
    std::string nonce;
    std::string client_version;
};

constexpr std::chrono::seconds REQUEST_TIMEOUT{ 5 };

[[nodiscard]] std::string trim(const std::string_view text)
{
    const auto begin{ text.find_first_not_of(" \t\r\n") };
    if (begin == std::string_view::npos) {
        return {};
    }

    const auto end{ text.find_last_not_of(" \t\r\n") };
    return std::string{ text.substr(begin, end - begin + 1) };
}

[[nodiscard]] Result make_error(const Status status, std::string message)
{
    return Result{ .status = status, .message = std::move(message) };
}
}

std::optional<std::string> read_machine_id()
{
#ifdef _WIN32
    HKEY key{ nullptr };
    if (RegOpenKeyExA(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Cryptography",
        0,
        KEY_QUERY_VALUE | KEY_WOW64_64KEY,
        &key
    ) != ERROR_SUCCESS) {
        return std::nullopt;
    }

    // One byte short of the buffer so the value is always null terminated.
    std::array<char, 128> value{};
    DWORD size{ static_cast<DWORD>(value.size() - 1) };
    DWORD type{ 0 };
    const auto status{
        RegQueryValueExA(key, "MachineGuid", nullptr, &type, reinterpret_cast<LPBYTE>(value.data()), &size)
    };
    RegCloseKey(key);

    if (status != ERROR_SUCCESS || type != REG_SZ) {
        return std::nullopt;
    }

    const auto id{ trim(value.data()) };
    if (id.empty()) {
        return std::nullopt;
    }

    // MachineGuid alone is one registry value that is easy to copy to another
    // computer, so mix in the serial number of the Windows drive as well.
    std::array<wchar_t, MAX_PATH> windows_dir{};
    DWORD volume_serial{ 0 };
    if (
        const auto length{ GetWindowsDirectoryW(windows_dir.data(), static_cast<UINT>(windows_dir.size())) };
        length >= 3 && length < windows_dir.size()
    ) {
        const std::wstring root{ windows_dir.data(), 3 }; // e.g. "C:\"
        GetVolumeInformationW(root.c_str(), nullptr, 0, &volume_serial, nullptr, nullptr, nullptr, 0);
    }

    return fmt::format("{}|{:08X}", id, volume_serial);
#elif defined(__APPLE__)
    uuid_t uuid{};
    const timespec wait{ 5, 0 };
    if (gethostuuid(uuid, &wait) != 0) {
        return std::nullopt;
    }

    uuid_string_t text{};
    uuid_unparse_upper(uuid, text);
    return std::string{ text };
#elif defined(__linux__)
    for (const auto* path : { "/etc/machine-id", "/var/lib/dbus/machine-id" }) {
        std::ifstream file{ path };
        std::string line{};
        if (!file || !std::getline(file, line)) {
            continue;
        }

        if (auto id{ trim(line) }; !id.empty()) {
            return id;
        }
    }

    return std::nullopt;
#else
    return std::nullopt;
#endif
}

std::optional<std::string> generate_nonce()
{
    std::array<std::byte, NONCE_LENGTH / 2> bytes{};
    if (RAND_bytes(reinterpret_cast<unsigned char*>(bytes.data()), static_cast<int>(bytes.size())) != 1) {
        return std::nullopt;
    }

    return to_hex(bytes);
}

LicenseClient::LicenseClient(std::string server_url, std::string public_key, std::string hwid)
    : server_url_{ std::move(server_url) }
    , public_key_{ std::move(public_key) }
    , hwid_{ std::move(hwid) }
{

}

Result LicenseClient::activate(const std::string_view key) const
{
    const auto normalized_key{ normalize_key(key) };
    if (!is_well_formed_key(normalized_key)) {
        // The server would answer 400, a server error that exits the proxy;
        // this can only be a mistyped key, so the user is asked again.
        return make_error(Status::InvalidKey, std::string{ describe(Status::InvalidKey) });
    }

    const auto nonce{ generate_nonce() };
    if (!nonce) {
        return make_error(Status::NetworkError, "Failed to generate a request nonce");
    }

    const ActivateRequest request{
        .key = normalized_key,
        .hwid = hwid_,
        .nonce = *nonce,
        .client_version = fmt::format("{}.{}.{}", GTPROXY_VERSION_MAJOR, GTPROXY_VERSION_MINOR, GTPROXY_VERSION_PATCH)
    };

    const auto body{ glz::write_json(request) };
    if (!body) {
        return make_error(Status::NetworkError, "Failed to encode the license request");
    }

    const auto [origin, base_path]{ split_server_url(server_url_) };

#ifndef _WIN32
    // A TLS write to a connection the server already closed raises SIGPIPE.
    // httplib::Server ignores it as well, but the startup check runs before
    // the web server exists.
    std::signal(SIGPIPE, SIG_IGN);
#endif

    try {
        httplib::Client client{ origin };
        client.set_connection_timeout(REQUEST_TIMEOUT);
        client.set_read_timeout(REQUEST_TIMEOUT);
        client.set_write_timeout(REQUEST_TIMEOUT);
        client.enable_server_certificate_verification(true);

        const auto response{ client.Post(fmt::format("{}/api/v1/activate", base_path), *body, "application/json") };
        if (!response) {
            return make_error(
                Status::NetworkError,
                fmt::format("Could not reach the license server: {}", httplib::to_string(response.error()))
            );
        }

        return process_response(response->status, response->body, public_key_, *nonce, hwid_);
    }
    catch (const std::exception& e) {
        return make_error(Status::NetworkError, fmt::format("License request failed: {}", e.what()));
    }
}
}
