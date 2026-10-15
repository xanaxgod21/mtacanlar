#pragma once
#include <string>
#include <string_view>

#include "world_manage_handler.hpp"
#include "../config.hpp"
#include "../../event/event.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// When enabled, wrenching a player in your world instantly pulls, kicks or
// world-bans them (whichever action is configured) instead of opening the
// wrench menu. The toggle and the chosen action are saved to config.json.
//
// Growtopia does not tell the proxy which mouse button was used, so a single
// configurable action is performed per wrench rather than a left/right split.
class QuickWrenchHandler {
public:
    using Action = WorldManageHandler::Action;

    QuickWrenchHandler(
        event::Dispatcher& dispatcher,
        network::Server& server,
        WorldManageHandler& world_manage,
        Config& config
    );

    QuickWrenchHandler(const QuickWrenchHandler&) = delete;
    QuickWrenchHandler& operator=(const QuickWrenchHandler&) = delete;
    QuickWrenchHandler(QuickWrenchHandler&&) noexcept = delete;
    QuickWrenchHandler& operator=(QuickWrenchHandler&&) noexcept = delete;
    ~QuickWrenchHandler() = default;

    [[nodiscard]] bool is_enabled() const { return config_.get_feature_config().quick_wrench; }
    void set_enabled(bool enabled);

    [[nodiscard]] Action get_action() const { return action_; }
    void set_action(Action action);

    [[nodiscard]] static Action action_from_string(std::string_view name);
    [[nodiscard]] static std::string_view action_to_string(Action action);

private:
    void on_wrench(const event::Event& event);
    void send_log(const std::string& msg) const;

    event::Dispatcher& dispatcher_;
    network::Server& server_;
    WorldManageHandler& world_manage_;
    Config& config_;
    Action action_;

    event::ScopedHandle handle_;
};
}
