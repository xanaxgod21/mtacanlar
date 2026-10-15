#include "world_manage_handler.hpp"

#include <fmt/format.h>
#include <fmt/ranges.h>
#include <spdlog/spdlog.h>

#include "../../packet/message/chat.hpp"
#include "../../packet/message/raw_text.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../world/world.hpp"

namespace core::handlers {
WorldManageHandler::WorldManageHandler(network::Client& client, network::Server& server, DialogInterceptor& dialogs)
    : client_{ client }
    , server_{ server }
    , dialogs_{ dialogs }
{

}

std::string_view WorldManageHandler::button_name(const Action action)
{
    switch (action) {
    case Action::Pull: return "pull";
    case Action::Kick: return "kick";
    case Action::Ban: return "worldban";
    }

    return {};
}

std::string_view WorldManageHandler::action_name(const Action action)
{
    switch (action) {
    case Action::Pull: return "pull";
    case Action::Kick: return "kick";
    case Action::Ban: return "ban";
    }

    return {};
}

WorldManageHandler::Result WorldManageHandler::request(const Action action, const int32_t net_id, const std::string& player_name)
{
    if (!client_.is_connected()) {
        return Result::NotConnected;
    }

    if (world::World::instance().get_local_net_id() < 0) {
        return Result::NotInWorld;
    }

    if (!send_text(fmt::format("action|wrench\n|netid|{}", net_id))) {
        return Result::NotConnected;
    }

    dialogs_.expect(
        "popup",
        [this, action, net_id, player_name](const packet::game::DialogInfo& dialog) {
            return on_popup(dialog, action, net_id, player_name);
        },
        DIALOG_TIMEOUT,
        [this, action, player_name] {
            send_log(fmt::format("`4Could not {} {}: ``the server did not open their wrench menu", action_name(action), player_name));
        }
    );

    spdlog::info("World: wrenched net id {} to {}", net_id, action_name(action));
    return Result::Sent;
}

bool WorldManageHandler::on_popup(
    const packet::game::DialogInfo& dialog,
    const Action action,
    const int32_t net_id,
    const std::string& player_name
) {
    if (dialog.get_embed_data("netID") != std::to_string(net_id)) {
        // Someone else's popup, e.g. one the player opened by hand.
        return false;
    }

    const auto button{ button_name(action) };
    if (!dialog.has_button(button)) {
        spdlog::info("World: wrench menu for net id {} has buttons [{}]", net_id, fmt::join(dialog.buttons, ", "));
        send_log(fmt::format("`4Could not {} {}: ``no such button in their menu. Is this your world?", action_name(action), player_name));
        return true;
    }

    const auto reply{ packet::game::make_dialog_return(dialog, { { "buttonClicked", std::string{ button } } }) };
    if (!send_text(reply)) {
        send_log(fmt::format("`4Could not {} {}: ``lost connection", action_name(action), player_name));
    }

    return true;
}

bool WorldManageHandler::send_text(const std::string_view text) const
{
    return client_.write(packet::message::make_raw_text(packet::NET_MESSAGE_GENERIC_TEXT, text));
}

void WorldManageHandler::send_log(const std::string& msg) const
{
    packet::message::Log log_pkt{};
    log_pkt.msg = msg;
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}
}
