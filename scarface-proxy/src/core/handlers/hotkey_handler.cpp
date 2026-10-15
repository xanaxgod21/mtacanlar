#include "hotkey_handler.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <chrono>
#include <string>
#include <tuple>

#ifdef _WIN32
#include <windows.h>
#endif

#include <fmt/format.h>

#include "auto_collect_handler.hpp"
#include "../branding.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/packet_helper.hpp"

namespace core::handlers {
HotkeyHandler::HotkeyHandler(
    std::shared_ptr<Scheduler> scheduler,
    AutoCollectHandler& autocollect,
    network::Server& server,
    Config& config
)
    : scheduler_{ std::move(scheduler) }
    , autocollect_{ autocollect }
    , server_{ server }
    , config_{ config }
{
    key_enabled_.store(config_.get_feature_config().autocollect_keybind);
    key_code_.store(config_.get_feature_config().autocollect_key);
#ifdef _WIN32
    running_.store(true);
    thread_ = std::thread{ [this] { run(); } };
#endif
}

HotkeyHandler::~HotkeyHandler()
{
    running_.store(false);
    if (thread_.joinable()) {
        thread_.join();
    }
}

void HotkeyHandler::set_enabled(const bool enabled)
{
    config_.get_feature_config().autocollect_keybind = enabled;
    std::ignore = config_.save();
    key_enabled_.store(enabled);
}

void HotkeyHandler::set_key(const int virtual_key)
{
    config_.get_feature_config().autocollect_key = virtual_key;
    std::ignore = config_.save();
    key_code_.store(virtual_key);
}

void HotkeyHandler::toggle_autocollect()
{
    const bool now{ !autocollect_.is_enabled() };
    autocollect_.set_enabled(now);
    if (now) {
        autocollect_.collect_nearby();
    }

    packet::message::Log log_pkt{};
    log_pkt.msg = fmt::format("{}Auto collect {}", core::branding::LOG_PREFIX, now ? "`2ON``" : "`4OFF``");
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}

int HotkeyHandler::key_from_name(const std::string_view name)
{
    std::string n{ name };
    std::erase_if(n, [](const unsigned char c) { return std::isspace(c); });
    std::ranges::transform(n, n.begin(), [](const unsigned char c) { return std::toupper(c); });
    if (n.empty()) {
        return 0;
    }

    if (n.front() == 'F' && n.size() >= 2) {
        int num{ 0 };
        const auto* begin{ n.data() + 1 };
        const auto* end{ n.data() + n.size() };
        if (auto [ptr, ec]{ std::from_chars(begin, end, num) }; ec == std::errc{} && ptr == end && num >= 1 && num <= 12) {
            return 0x70 + (num - 1); // VK_F1 = 0x70
        }
        return 0;
    }

    if (n.size() == 1) {
        const char c{ n.front() };
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            return static_cast<int>(static_cast<unsigned char>(c)); // VK matches ASCII for A-Z and 0-9.
        }
    }

    return 0;
}

std::string HotkeyHandler::name_from_key(const int virtual_key)
{
    if (virtual_key >= 0x70 && virtual_key <= 0x7B) {
        return fmt::format("F{}", virtual_key - 0x70 + 1);
    }

    if ((virtual_key >= 'A' && virtual_key <= 'Z') || (virtual_key >= '0' && virtual_key <= '9')) {
        return std::string(1, static_cast<char>(virtual_key));
    }

    return "F6";
}

#ifdef _WIN32
bool HotkeyHandler::growtopia_focused()
{
    const HWND hwnd{ GetForegroundWindow() };
    if (!hwnd) {
        return false;
    }

    char title[256]{};
    const int len{ GetWindowTextA(hwnd, title, static_cast<int>(sizeof(title))) };
    if (len <= 0) {
        return false;
    }

    std::string t{ title, static_cast<std::size_t>(len) };
    std::ranges::transform(t, t.begin(), [](const unsigned char c) { return std::tolower(c); });
    return t.find("growtopia") != std::string::npos;
}

void HotkeyHandler::run()
{
    bool was_down{ false };
    while (running_.load()) {
        if (key_enabled_.load()) {
            const int vk{ key_code_.load() };
            const bool down{ vk > 0 && (GetAsyncKeyState(vk) & 0x8000) != 0 };
            if (down && !was_down && growtopia_focused()) {
                scheduler_->post_to_main_thread([this] { toggle_autocollect(); });
            }

            was_down = down;
        }
        else {
            was_down = false;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds{ 40 });
    }
}
#endif
}
