#pragma once
#include <string>

#include "quick_wrench_handler.hpp"
#include "roulette_handler.hpp"
#include "mod_alert_handler.hpp"
#include "fun_facts_handler.hpp"
#include "fast_drop_handler.hpp"
#include "auto_collect_handler.hpp"
#include "hotkey_handler.hpp"
#include "pathfind_handler.hpp"
#include "../../event/event.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// Backs the "/proxy" options menu: sends an in-game dialog with a checkbox per
// feature and applies the toggles when the player presses Save. Each toggle is
// forwarded to the feature's own handler, which saves it to config.json.
class ProxyMenuHandler {
public:
    ProxyMenuHandler(
        event::Dispatcher& dispatcher,
        network::Server& server,
        QuickWrenchHandler& quick_wrench,
        RouletteHandler& roulette,
        ModAlertHandler& mod_alert,
        FunFactsHandler& fun_facts,
        FastDropHandler& fast_drop,
        AutoCollectHandler& auto_collect,
        HotkeyHandler& hotkey,
        PathfindHandler& pathfind
    );

    ProxyMenuHandler(const ProxyMenuHandler&) = delete;
    ProxyMenuHandler& operator=(const ProxyMenuHandler&) = delete;
    ProxyMenuHandler(ProxyMenuHandler&&) noexcept = delete;
    ProxyMenuHandler& operator=(ProxyMenuHandler&&) noexcept = delete;
    ~ProxyMenuHandler() = default;

    // Shows the options dialog to the player.
    void open() const;

private:
    static constexpr const char* DIALOG_NAME{ "scarface_options" };

    void on_dialog_return(const event::Event& event);
    [[nodiscard]] std::string build_dialog() const;
    void send_log(const std::string& msg) const;

    event::Dispatcher& dispatcher_;
    network::Server& server_;
    QuickWrenchHandler& quick_wrench_;
    RouletteHandler& roulette_;
    ModAlertHandler& mod_alert_;
    FunFactsHandler& fun_facts_;
    FastDropHandler& fast_drop_;
    AutoCollectHandler& auto_collect_;
    HotkeyHandler& hotkey_;
    PathfindHandler& pathfind_;

    event::ScopedHandle handle_;
};
}
