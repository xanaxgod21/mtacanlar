#include "world_handler.hpp"

#include <glm/glm.hpp>

#include "../../event/event.hpp"
#include "../../packet/game/player.hpp"
#include "../../packet/game/world.hpp"
#include "../../world/world.hpp"
#include "../../world/object.hpp"
#include "../../world/tile.hpp"
#include "../../player/player.hpp"
#include "../../utils/byte_stream.hpp"

namespace core::handlers {
WorldHandler::WorldHandler(event::Dispatcher& dispatcher)
    : dispatcher_{ dispatcher }
{
    setup_join_request_handler();
    setup_on_spawn_handler();
    setup_on_remove_handler();
    setup_send_map_data_handler();
    setup_send_tile_update_data_handler();
    setup_tile_change_request_handler();
    setup_item_change_object_handler();
    setup_state_handler();
}

void WorldHandler::setup_join_request_handler()
{
    constexpr auto join_request_type{ event::packet_event_type(packet::PacketId::JoinRequest) };
    handles_.emplace_back(
        dispatcher_,
        join_request_type,
        dispatcher_.append_listener(join_request_type, [](const event::Event& event) {
            if (
                const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::JoinRequest>*>(&event) };
                !evt || evt->direction != event::Direction::ServerBound
            ) {
                return;
            }

            world::World::instance().clear();
        })
    );
}

void WorldHandler::setup_on_spawn_handler()
{
    constexpr auto on_spawn_type{ event::packet_event_type(packet::PacketId::OnSpawn) };
    handles_.emplace_back(
        dispatcher_,
        on_spawn_type,
        dispatcher_.append_listener(on_spawn_type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::OnSpawn>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::OnSpawn>() };
            if (!pkt) {
                return;
            }

            const auto player{ player::Player::from_on_spawn(*pkt) };
            world::World::instance().add_player(player);
        })
    );
}

void WorldHandler::setup_on_remove_handler()
{
    constexpr auto on_remove_type{ event::packet_event_type(packet::PacketId::OnRemove) };
    handles_.emplace_back(
        dispatcher_,
        on_remove_type,
        dispatcher_.append_listener(on_remove_type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::OnRemove>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::OnRemove>() };
            if (!pkt) {
                return;
            }

            world::World::instance().remove_player(pkt->net_id);
        })
    );
}

void WorldHandler::setup_send_map_data_handler()
{
    constexpr auto send_map_data_type{ event::packet_event_type(packet::PacketId::SendMapData) };
    handles_.emplace_back(
        dispatcher_,
        send_map_data_type,
        dispatcher_.append_listener(send_map_data_type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::SendMapData>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::SendMapData>() };
            if (!pkt || pkt->extra.empty()) {
                return;
            }

            world::World::instance().serialize(pkt->extra.data(), pkt->extra.size());
        })
    );
}

void WorldHandler::setup_send_tile_update_data_handler()
{
    constexpr auto send_tile_update_data_type{ event::packet_event_type(packet::PacketId::SendTileUpdateData) };
    handles_.emplace_back(
        dispatcher_,
        send_tile_update_data_type,
        dispatcher_.append_listener(send_tile_update_data_type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::SendTileUpdateData>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::SendTileUpdateData>() };
            if (!pkt || pkt->extra.empty()) {
                return;
            }

            const auto& world{ world::World::instance() };
            world::Tile tile{};

            utils::ByteStream<> bs{ pkt->extra.data(), pkt->extra.size() };
            tile.serialize(bs, world.get_version());

            // Update tile in map if coordinates are available in game_packet
            // Note: SendTileUpdateData typically doesn't include coords in the packet itself
            // The coordinates would need to come from parsing the extended data
        })
    );
}

void WorldHandler::setup_tile_change_request_handler()
{
    constexpr auto tile_change_request_type{ event::packet_event_type(packet::PacketId::TileChangeRequest) };
    handles_.emplace_back(
        dispatcher_,
        tile_change_request_type,
        dispatcher_.append_listener(tile_change_request_type, [](const event::Event& event) {
            // The client sends a TileChangeRequest for every punch, but the tile only
            // changes once the server broadcasts one back, so track the client-bound side only.
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::TileChangeRequest>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::TileChangeRequest>() };
            if (!pkt) {
                return;
            }

            auto& world{ world::World::instance() };
            auto& tile_map{ world.get_tile_map() };
            const auto& size{ tile_map.get_size() };
            if (pkt->int_x < 0 || pkt->int_y < 0 || pkt->int_x >= size.x || pkt->int_y >= size.y) {
                return;
            }

            const std::size_t index{ static_cast<std::size_t>(pkt->int_x + pkt->int_y * size.x) };
            if (index >= tile_map.get_tiles().size()) {
                return;
            }

            if (pkt->item_id == 18) {
                if (auto& tile{ tile_map.get_tiles()[index] }; tile.foreground != 0) {
                    tile.foreground = 0;
                }
                else {
                    tile.background = 0;
                }
            }

            // TODO: Block placement requires ItemDatabase
        })
    );
}

void WorldHandler::setup_item_change_object_handler()
{
    constexpr auto item_change_object_type{ event::packet_event_type(packet::PacketId::ItemChangeObject) };
    handles_.emplace_back(
        dispatcher_,
        item_change_object_type,
        dispatcher_.append_listener(item_change_object_type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::ItemChangeObject>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::ItemChangeObject>() };
            if (!pkt) {
                return;
            }

            auto& world{ world::World::instance() };
            auto& object_map{ world.get_object_map() };

            if (pkt->object_change_type == -1) {
                object_map.increment_drop_id();
                
                world::Object obj{};
                obj.pos = glm::vec2{ pkt->pos_x, pkt->pos_y };
                obj.item_id = static_cast<std::uint16_t>(pkt->item_id);
                obj.amount = static_cast<std::uint8_t>(pkt->amount);
                obj.object_id = object_map.get_drop_id();
                object_map.get_objects().push_back(obj);
            }
            else if (pkt->object_change_type == -3) {
                for (auto& obj : object_map.get_objects()) {
                    if (obj.object_id == static_cast<std::uint32_t>(pkt->item_net_id)) {
                        obj.pos = glm::vec2{ pkt->pos_x, pkt->pos_y };
                        obj.item_id = static_cast<std::uint16_t>(pkt->item_id);
                        obj.amount = static_cast<std::uint8_t>(pkt->amount);
                        break;
                    }
                }
            }
            else {
                auto& objects{ object_map.get_objects() };
                const auto erase_object = [&objects](const std::uint32_t object_id) {
                    return std::erase_if(objects, [object_id](const world::Object& obj) {
                        return obj.object_id == object_id;
                    }) > 0;
                };

                // The collected drop id is carried in int_data; older code read it from
                // item_net_id, so fall back to that if nothing matched.
                if (!erase_object(static_cast<std::uint32_t>(pkt->item_id))) {
                    std::ignore = erase_object(static_cast<std::uint32_t>(pkt->item_net_id));
                }

                // TODO: Inventory updates
            }
        })
    );
}

void WorldHandler::setup_state_handler()
{
    constexpr auto state_type{ event::packet_event_type(packet::PacketId::State) };
    handles_.emplace_back(
        dispatcher_,
        state_type,
        dispatcher_.append_listener(state_type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::State>*>(&event) };
            if (!evt) {
                return;
            }

            const auto pkt{ evt->get<packet::game::State>() };
            if (!pkt) {
                return;
            }

            // Server-bound state packets always describe the local player.
            const auto& world{ world::World::instance() };
            const auto player{
                evt->direction == event::Direction::ServerBound
                    ? world.get_local_player().lock()
                    : world.get_player(pkt->net_id).lock()
            };

            if (player) {
                player->set_position(glm::i32vec2{ static_cast<int32_t>(pkt->pos_x), static_cast<int32_t>(pkt->pos_y) });
            }
        })
    );
}
}
