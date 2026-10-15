#pragma once
#include <cstdint>
#include <optional>

namespace item::locks {
constexpr std::uint16_t WORLD_LOCK{ 242 };
constexpr std::uint16_t DIAMOND_LOCK{ 1796 };
constexpr std::uint16_t BLUE_GEM_LOCK{ 7188 };

// One lock of each tier is worth 100 of the tier below it.
constexpr int TIER_RATIO{ 100 };

// The lock that shatters into `item_id` when used from the inventory
// (a Diamond Lock into 100 World Locks, a Blue Gem Lock into 100 Diamond Locks).
[[nodiscard]] constexpr std::optional<std::uint16_t> higher_tier(const std::uint16_t item_id)
{
    switch (item_id) {
    case WORLD_LOCK: return DIAMOND_LOCK;
    case DIAMOND_LOCK: return BLUE_GEM_LOCK;
    default: return std::nullopt;
    }
}

[[nodiscard]] constexpr int value_in_world_locks(const int world_locks, const int diamond_locks, const int blue_gem_locks)
{
    return world_locks + diamond_locks * TIER_RATIO + blue_gem_locks * TIER_RATIO * TIER_RATIO;
}
}
