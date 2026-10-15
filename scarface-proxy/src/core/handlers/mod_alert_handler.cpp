#include "mod_alert_handler.hpp"

#include <fmt/format.h>
#include <fmt/ranges.h>
#include <spdlog/spdlog.h>

#include "../../packet/game/message.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/message/raw_text.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../player/staff.hpp"
#include "../../utils/color_codes.hpp"

namespace core::handlers {
ModAlertHandler::ModAlertHandler(event::Dispatcher& dispatcher, network::Server& server, Config& config)
    : dispatcher_{ dispatcher }
    , server_{ server }
    , config_{ config }
    , enabled_{ config.get_feature_config().mod_alert }
{
    constexpr auto type{ event::packet_event_type(packet::PacketId::OnSpawn) };
    handles_.emplace_back(
        dispatcher_,
        type,
        dispatcher_.append_listener(type, [this](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::OnSpawn>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            if (const auto pkt{ evt->get<packet::game::OnSpawn>() }) {
                on_spawn(*pkt);
            }
        })
    );
}

void ModAlertHandler::set_enabled(const bool enabled)
{
    enabled_ = enabled;

    config_.get_feature_config().mod_alert = enabled;
    std::ignore = config_.save();
}

void ModAlertHandler::on_spawn(const packet::game::OnSpawn& spawn) const
{
    if (spawn.type == "local") {
        return;
    }

    const auto reasons{ player::staff_reasons(spawn) };
    if (reasons.empty()) {
        return;
    }

    const auto name{ utils::strip_color_codes(spawn.name) };
    spdlog::warn("Mod alert: {} (net id {}) is in the world [{}]", name, spawn.net_id, fmt::join(reasons, ", "));

    if (!enabled_) {
        return;
    }

    packet::message::Log log{};
    log.msg = fmt::format("`4[MOD ALERT] ```w{}`` is in this world `o({})``", name, fmt::join(reasons, ", "));
    std::ignore = packet::PacketHelper::write(log, server_);

    packet::game::OnTextOverlay overlay{};
    overlay.text = fmt::format("`4MOD ALERT: ```w{}``", name);
    std::ignore = packet::PacketHelper::write(overlay, server_);

    std::ignore = server_.write(packet::message::make_raw_text(
        packet::NET_MESSAGE_GAME_MESSAGE,
        "action|play_sfx\nfile|audio/explode.wav\ndelayMS|0"
    ));
}
}
