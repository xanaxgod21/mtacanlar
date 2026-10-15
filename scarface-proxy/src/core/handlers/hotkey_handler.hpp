#pragma once
#include <atomic>
#include <memory>
#include <string>
#include <string_view>
#include <thread>

#include "../config.hpp"
#include "../scheduler.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
class AutoCollectHandler;

// Toggles Auto Collect with a global hotkey. The proxy runs locally on the
// player's own PC, so it can read the keyboard straight from the OS (Windows:
// GetAsyncKeyState), independently of the game's network traffic - the same
// reason a client-side mod could, and the reason a key *press* works where an
// in-game "shift+click" position never reaches the proxy. The press only
// toggles while the Growtopia window is focused. Windows only; a no-op on
// other platforms (the toggle and key are still saved and usable from /proxy).
class HotkeyHandler {
public:
    HotkeyHandler(
        std::shared_ptr<Scheduler> scheduler,
        AutoCollectHandler& autocollect,
        network::Server& server,
        Config& config
    );

    HotkeyHandler(const HotkeyHandler&) = delete;
    HotkeyHandler& operator=(const HotkeyHandler&) = delete;
    HotkeyHandler(HotkeyHandler&&) noexcept = delete;
    HotkeyHandler& operator=(HotkeyHandler&&) noexcept = delete;
    ~HotkeyHandler();

    [[nodiscard]] bool is_enabled() const { return config_.get_feature_config().autocollect_keybind; }
    void set_enabled(bool enabled);

    [[nodiscard]] int get_key() const { return config_.get_feature_config().autocollect_key; }
    void set_key(int virtual_key);

    // "F6" / "C" / "7" <-> a Windows virtual-key code. key_from_name returns 0
    // for anything it does not recognise; name_from_key falls back to "F6".
    [[nodiscard]] static int key_from_name(std::string_view name);
    [[nodiscard]] static std::string name_from_key(int virtual_key);

private:
    void toggle_autocollect();
#ifdef _WIN32
    void run();
    [[nodiscard]] static bool growtopia_focused();
#endif

    std::shared_ptr<Scheduler> scheduler_;
    AutoCollectHandler& autocollect_;
    network::Server& server_;
    Config& config_;

    // Read by the worker thread, written on the main thread via set_*; kept
    // atomic so the poll loop never races the config fields behind them.
    std::atomic<bool> key_enabled_{ false };
    std::atomic<int> key_code_{ 0 };

    std::atomic<bool> running_{ false };
    std::thread thread_;
};
}
