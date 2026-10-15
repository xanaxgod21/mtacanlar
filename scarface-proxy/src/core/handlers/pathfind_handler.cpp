#include "pathfind_handler.hpp"

#include <cstdint>
#include <tuple>

#include <glm/glm.hpp>
#include <spdlog/spdlog.h>

#include "../../packet/game/player.hpp"
#include "../../packet/game/world.hpp"
#include "../../packet/generic_packets.hpp"
#include "../../packet/packet_helper.hpp"
#include "../../packet/packet_variant.hpp"
#include "../../world/world.hpp"

namespace core::handlers {
namespace {
    constexpr auto tile_change_type{ event::packet_event_type(packet::PacketId::TileChangeRequest) };
}

PathfindHandler::PathfindHandler(event::Dispatcher& dispatcher, network::Client& client, network::Server& server, Config& config)
    : dispatcher_{ dispatcher }
    , client_{ client }
    , server_{ server }
    , config_{ config }
{
    handle_ = event::ScopedHandle{
        dispatcher_,
        tile_change_type,
        dispatcher_.append_listener(tile_change_type, [this](const event::Event& e) { on_tile_change(e); })
    };
}

void PathfindHandler::set_enabled(const bool enabled)
{
    config_.get_feature_config().pathfind = enabled;
    std::ignore = config_.save();
}

void PathfindHandler::on_tile_change(const event::Event& event)
{
    if (!is_enabled()) {
        return;
    }

    const auto* evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::TileChangeRequest>*>(&event) };
    if (!evt || evt->direction != event::Direction::ServerBound) {
        return;
    }

    const auto pkt{ evt->get<packet::game::TileChangeRequest>() };
    if (!pkt) {
        return;
    }

    if (world::World::instance().get_local_net_id() < 0) {
        return; // Not in a world yet.
    }

    // Take over the click: no punch/place, teleport instead.
    evt->cancel();
    teleport(pkt->int_x, pkt->int_y);
}

void PathfindHandler::teleport(const int tile_x, const int tile_y)
{
    const auto net_id{ world::World::instance().get_local_net_id() };
    const float px{ static_cast<float>(tile_x) * TILE_SIZE };
    const float py{ static_cast<float>(tile_y) * TILE_SIZE };

    // Snap the local player on the client.
    packet::GenericVariantPacket set_pos{};
    set_pos.game_packet.net_id = static_cast<std::uint32_t>(net_id);
    set_pos.variant = packet::PacketVariant{ "OnSetPos", glm::vec2{ px, py } };
    std::ignore = packet::PacketHelper::write(set_pos, server_);

    // Report the new position to the server so it (and other players) agree.
    packet::game::State state{};
    state.net_id = net_id;
    state.pos_x = px;
    state.pos_y = py;
    std::ignore = packet::PacketHelper::write(state, client_);

    // Keep the proxy's own idea of where we are in sync.
    if (const auto player{ world::World::instance().get_local_player().lock() }) {
        player->set_position(glm::i32vec2{ static_cast<int>(px), static_cast<int>(py) });
    }

    spdlog::info("Pathfind: teleport to tile {},{} (px {:.0f},{:.0f})", tile_x, tile_y, px, py);
}
}
