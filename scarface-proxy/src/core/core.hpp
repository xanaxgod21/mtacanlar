#pragma once
#include <atomic>

#include "config.hpp"
#include "scheduler.hpp"
#include "web_server.hpp"
#include "handlers/auto_collect_handler.hpp"
#include "handlers/connection_handler.hpp"
#include "handlers/dialog_interceptor.hpp"
#include "handlers/drop_handler.hpp"
#include "handlers/forwarding_handler.hpp"
#include "handlers/inventory_handler.hpp"
#include "handlers/mod_alert_handler.hpp"
#include "handlers/roulette_handler.hpp"
#include "handlers/world_handler.hpp"
#include "handlers/world_manage_handler.hpp"
#include "handlers/quick_wrench_handler.hpp"
#include "handlers/fast_drop_handler.hpp"
#include "handlers/hotkey_handler.hpp"
#include "handlers/pathfind_handler.hpp"
#include "handlers/fun_facts_handler.hpp"
#include "handlers/proxy_menu_handler.hpp"
#include "../command/command_handler.hpp"
#include "../network/client.hpp"
#include "../network/server.hpp"
#include "../scripting/lua_engine.hpp"
#include "../scripting/script_event_bridge.hpp"
#include "../scripting/script_loader.hpp"
#include "../scripting/script_scheduler.hpp"
#include "../utils/types.hpp"

namespace core {
class Core final : public utils::types::Immobile {
public:
    Core();
    ~Core();

    void run() const;
    void stop() { running_ = false; }

    [[nodiscard]] Config& get_config() { return config_; }
    [[nodiscard]] Scheduler& get_scheduler() { return *scheduler_; }

private:
    void register_feature_commands();

    Config config_;
    std::atomic<bool> running_;

    event::Dispatcher dispatcher_;
    std::shared_ptr<Scheduler> scheduler_;

    std::unique_ptr<network::Server> server_;
    std::unique_ptr<network::Client> client_;
    std::unique_ptr<WebServer> web_server_;

    std::unique_ptr<handlers::ConnectionHandler> connection_handler_;
    std::unique_ptr<handlers::ForwardingHandler> forwarding_handler_;
    std::unique_ptr<handlers::WorldHandler> world_handler_;
    // Declared before command_handler_, whose commands reference them.
    std::unique_ptr<handlers::DialogInterceptor> dialog_interceptor_;
    std::unique_ptr<handlers::InventoryHandler> inventory_handler_;
    std::unique_ptr<handlers::AutoCollectHandler> auto_collect_handler_;
    std::unique_ptr<handlers::HotkeyHandler> hotkey_handler_;
    std::unique_ptr<handlers::PathfindHandler> pathfind_handler_;
    std::unique_ptr<handlers::DropHandler> drop_handler_;
    std::unique_ptr<handlers::WorldManageHandler> world_manage_handler_;
    std::unique_ptr<handlers::QuickWrenchHandler> quick_wrench_handler_;
    std::unique_ptr<handlers::FastDropHandler> fast_drop_handler_;
    std::unique_ptr<handlers::FunFactsHandler> fun_facts_handler_;
    std::unique_ptr<handlers::RouletteHandler> roulette_handler_;
    std::unique_ptr<handlers::ModAlertHandler> mod_alert_handler_;
    std::unique_ptr<handlers::ProxyMenuHandler> proxy_menu_handler_;
    std::unique_ptr<command::CommandHandler> command_handler_;

    std::unique_ptr<scripting::LuaEngine> script_engine_;
    std::unique_ptr<scripting::ScriptScheduler> script_scheduler_;
    std::unique_ptr<scripting::ScriptEventBridge> script_event_bridge_;
    std::unique_ptr<scripting::ScriptLoader> script_loader_;
};
}
