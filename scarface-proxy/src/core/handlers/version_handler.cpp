#include "version_handler.hpp"

#include <tuple>

#include <spdlog/spdlog.h>

#include "../../packet/message/login.hpp"

namespace core::handlers {
VersionHandler::VersionHandler(event::Dispatcher& dispatcher, Config& config)
    : dispatcher_{ dispatcher }
    , config_{ config }
    , game_version_{ config.get_client_config().game_version }
    , protocol_{ config.get_client_config().protocol }
{
    constexpr auto type{ event::packet_event_type(packet::PacketId::LoginRequest) };
    handles_.emplace_back(
        dispatcher_,
        type,
        dispatcher_.append_listener(type, [this](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::LoginRequest>*>(&event) };
            if (!evt || evt->direction != event::Direction::ServerBound) {
                return;
            }

            // Read-only: the login is never cancelled, so the original bytes
            // still reach the Growtopia server untouched.
            const auto pkt{ evt->get<packet::message::LoginRequest>() };
            if (!pkt) {
                return;
            }

            if (pkt->game_version.empty() && pkt->protocol <= 0) {
                return;
            }

            const bool changed{
                (!pkt->game_version.empty() && pkt->game_version != game_version_)
                || (pkt->protocol > 0 && pkt->protocol != protocol_)
            };

            if (!pkt->game_version.empty()) {
                game_version_ = pkt->game_version;
            }
            if (pkt->protocol > 0) {
                protocol_ = pkt->protocol;
            }

            if (!changed) {
                return;
            }

            spdlog::info("Detected Growtopia client version {} (protocol {})", game_version_, protocol_);

            // Keep config.json in sync so it reflects the live version instead
            // of a stale hard-coded one.
            config_.get_client_config().game_version = game_version_;
            config_.get_client_config().protocol = protocol_;
            std::ignore = config_.save();
        })
    );
}
}
