#pragma once
#include <vector>

#include "../../event/event.hpp"

namespace core::handlers {
// Keeps player::Inventory up to date: full snapshots from SendInventoryState and
// drops the local player picks up. The DropHandler adjusts it for drops.
class InventoryHandler {
public:
    explicit InventoryHandler(event::Dispatcher& dispatcher);

    InventoryHandler(const InventoryHandler&) = delete;
    InventoryHandler& operator=(const InventoryHandler&) = delete;
    InventoryHandler(InventoryHandler&&) noexcept = delete;
    InventoryHandler& operator=(InventoryHandler&&) noexcept = delete;
    ~InventoryHandler() = default;

private:
    void setup_inventory_state_handler();
    void setup_pickup_handler();

    event::Dispatcher& dispatcher_;
    std::vector<event::ScopedHandle> handles_;
};
}
