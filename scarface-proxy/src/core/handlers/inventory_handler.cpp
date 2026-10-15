#include "inventory_handler.hpp"

#include <algorithm>
#include <spdlog/spdlog.h>

#include "../../packet/game/inventory.hpp"
#include "../../packet/game/world.hpp"
#include "../../player/inventory.hpp"
#include "../../world/world.hpp"

namespace core::handlers {
InventoryHandler::InventoryHandler(event::Dispatcher& dispatcher)
    : dispatcher_{ dispatcher }
{
    setup_inventory_state_handler();
    setup_pickup_handler();
}

void InventoryHandler::setup_inventory_state_handler()
{
    constexpr auto type{ event::packet_event_type(packet::PacketId::SendInventoryState) };
    handles_.emplace_back(
        dispatcher_,
        type,
        dispatcher_.append_listener(type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::SendInventoryState>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::SendInventoryState>() };
            if (!pkt) {
                return;
            }

            auto& inventory{ player::Inventory::instance() };
            if (!inventory.parse(pkt->extra)) {
                spdlog::warn("Inventory: failed to parse inventory state ({} bytes)", pkt->extra.size());
                return;
            }

            spdlog::info(
                "Inventory: {} item types in {} slots",
                inventory.get_items().size(),
                inventory.get_slot_count()
            );
        })
    );
}

void InventoryHandler::setup_pickup_handler()
{
    constexpr auto type{ event::packet_event_type(packet::PacketId::ItemChangeObject) };
    handles_.emplace_back(
        dispatcher_,
        type,
        // Runs before the WorldHandler removes the collected drop, so its item and
        // amount can still be looked up.
        dispatcher_.append_listener(type, [](const event::Event& event) {
            const auto evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::ItemChangeObject>*>(&event) };
            if (!evt || evt->direction != event::Direction::ClientBound) {
                return;
            }

            const auto pkt{ evt->get<packet::game::ItemChangeObject>() };
            auto& world{ world::World::instance() };
            if (!pkt || world.get_local_net_id() < 0 || pkt->object_change_type != world.get_local_net_id()) {
                return;
            }

            const auto& objects{ world.get_object_map().get_objects() };
            const auto find_object = [&objects](const std::uint32_t object_id) {
                return std::ranges::find_if(objects, [object_id](const world::Object& obj) {
                    return obj.object_id == object_id;
                });
            };

            auto it{ find_object(static_cast<std::uint32_t>(pkt->item_id)) };
            if (it == objects.end()) {
                it = find_object(static_cast<std::uint32_t>(pkt->item_net_id));
            }

            if (it != objects.end()) {
                player::Inventory::instance().add(it->item_id, it->amount);
            }
        }, event::Priority::FairlyHigh)
    );
}
}
