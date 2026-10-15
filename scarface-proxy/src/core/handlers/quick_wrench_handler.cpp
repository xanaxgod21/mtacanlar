#include "quick_wrench_handler.hpp"

#include <tuple>

#include <spdlog/spdlog.h>

#include "../../packet/message/chat.hpp"
#include "../../packet/message/wrench.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../utils/color_codes.hpp"
#include "../../world/world.hpp"

namespace core::handlers {
namespace {
    constexpr auto wrench_event_type{ event::packet_event_type(packet::PacketId::Wrench) };
}

QuickWrenchHandler::QuickWrenchHandler(
    event::Dispatcher& dispatcher,
    network::Server& server,
    WorldManageHandler& world_manage,
    Config& config
)
    : dispatcher_{ dispatcher }
    , server_{ server }
    , world_manage_{ world_manage }
    , config_{ config }
    , action_{ action_from_string(config.get_feature_config().quick_wrench_action) }
{
    handle_ = event::ScopedHandle{
        dispatcher_,
        wrench_event_type,
        dispatcher_.append_listener(wrench_event_type, [this](const event::Event& e) { on_wrench(e); })
    };
}

void QuickWrenchHandler::set_enabled(const bool enabled)
{
    config_.get_feature_config().quick_wrench = enabled;
    std::ignore = config_.save();
}

void QuickWrenchHandler::set_action(const Action action)
{
    action_ = action;
    config_.get_feature_config().quick_wrench_action = std::string{ action_to_string(action) };
    std::ignore = config_.save();
}

void QuickWrenchHandler::on_wrench(const event::Event& event)
{
    if (!is_enabled()) {
        return;
    }

    const auto* evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::Wrench>*>(&event) };
    if (!evt || evt->direction != event::Direction::ServerBound) {
        return;
    }

    const auto pkt{ evt->get<packet::message::Wrench>() };
    if (!pkt) {
        return;
    }

    const int32_t net_id{ pkt->net_id };
    const auto& world{ world::World::instance() };
    if (net_id <= 0 || net_id == world.get_local_net_id()) {
        // A tile wrench (net id -1) or wrenching yourself: leave it alone.
        return;
    }

    const auto player{ world.get_player(net_id).lock() };
    if (!player) {
        // Not a player in this world: let the wrench go through normally.
        return;
    }

    // Take over: swallow the wrench so the server's menu never opens, and do
    // the configured action instead.
    evt->cancel();

    const std::string name{ utils::strip_color_codes(player->name()) };
    spdlog::info("Quick wrench: {} net id {} ({})", action_to_string(action_), net_id, name);

    switch (world_manage_.request(action_, net_id, name)) {
    case WorldManageHandler::Result::Sent:
        break;
    case WorldManageHandler::Result::NotInWorld:
        send_log("`4Quick wrench: ``you are not in a world");
        break;
    case WorldManageHandler::Result::NotConnected:
        send_log("`4Quick wrench: ``not connected to the server");
        break;
    }
}

void QuickWrenchHandler::send_log(const std::string& msg) const
{
    packet::message::Log log_pkt{};
    log_pkt.msg = msg;
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}

QuickWrenchHandler::Action QuickWrenchHandler::action_from_string(const std::string_view name)
{
    if (name == "kick") {
        return Action::Kick;
    }

    if (name == "ban") {
        return Action::Ban;
    }

    return Action::Pull;
}

std::string_view QuickWrenchHandler::action_to_string(const Action action)
{
    switch (action) {
    case Action::Pull: return "pull";
    case Action::Kick: return "kick";
    case Action::Ban: return "ban";
    }

    return "pull";
}
}
