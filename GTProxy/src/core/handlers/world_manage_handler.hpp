#pragma once
#include <chrono>
#include <cstdint>
#include <string>
#include <string_view>

#include "dialog_interceptor.hpp"
#include "../../network/client.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// Pull, kick or world-ban a player without clicking through the wrench menu:
// wrenches the player like the client does, hides the popup the server opens
// and presses the button.
class WorldManageHandler {
public:
    enum class Action {
        Pull,
        Kick,
        Ban,
    };

    enum class Result {
        Sent,
        NotConnected,
        NotInWorld,
    };

    WorldManageHandler(network::Client& client, network::Server& server, DialogInterceptor& dialogs);

    WorldManageHandler(const WorldManageHandler&) = delete;
    WorldManageHandler& operator=(const WorldManageHandler&) = delete;
    WorldManageHandler(WorldManageHandler&&) noexcept = delete;
    WorldManageHandler& operator=(WorldManageHandler&&) noexcept = delete;
    ~WorldManageHandler() = default;

    Result request(Action action, int32_t net_id, const std::string& player_name);

    // The wrench popup button that performs the action.
    [[nodiscard]] static std::string_view button_name(Action action);
    [[nodiscard]] static std::string_view action_name(Action action);

private:
    static constexpr auto DIALOG_TIMEOUT{ std::chrono::milliseconds{ 3000 } };

    bool on_popup(const packet::game::DialogInfo& dialog, Action action, int32_t net_id, const std::string& player_name);
    bool send_text(std::string_view text) const;
    void send_log(const std::string& msg) const;

    network::Client& client_;
    network::Server& server_;
    DialogInterceptor& dialogs_;
};
}
