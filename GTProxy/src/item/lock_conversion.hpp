#pragma once
#include <cstdint>
#include <optional>

#include "locks.hpp"
#include "../player/inventory.hpp"

namespace item::locks {
struct Conversion {
    std::uint16_t source_item{ 0 };
    int count{ 0 };
};

// Which higher tier locks to shatter so `amount` of `item_id` can be dropped,
// or nullopt if nothing needs converting or it is not possible or safe.
[[nodiscard]] inline std::optional<Conversion> plan_conversion(
    const std::uint16_t item_id,
    const int amount,
    const player::Inventory& inventory
) {
    if (!inventory.is_known()) {
        return std::nullopt;
    }

    const int have{ inventory.get(item_id) };
    if (have >= amount) {
        return std::nullopt;
    }

    const auto source{ higher_tier(item_id) };
    if (!source) {
        return std::nullopt;
    }

    const int needed{ (amount - have + TIER_RATIO - 1) / TIER_RATIO };
    const int source_have{ inventory.get(*source) };

    // Using a lock while holding 100 of them compresses them into the next tier
    // instead of shattering one, so only convert below that.
    if (source_have < needed || source_have >= TIER_RATIO) {
        return std::nullopt;
    }

    if (have + needed * TIER_RATIO > player::Inventory::MAX_STACK) {
        return std::nullopt;
    }

    return Conversion{ *source, needed };
}
}
