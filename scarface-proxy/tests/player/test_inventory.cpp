#include <cstring>
#include <gtest/gtest.h>
#include "item/lock_conversion.hpp"
#include "player/inventory.hpp"

using namespace player;
namespace locks = item::locks;

namespace {
// Builds a SendInventoryState payload: [u8 version][u32 slots][u16 count] + [u16 id][u8 amount][u8 flags]...
std::vector<std::byte> inventory_payload(const std::vector<std::pair<std::uint16_t, std::uint8_t>>& items, const std::uint32_t slots = 36)
{
    std::vector<std::byte> data{};
    auto put = [&data](const auto value) {
        const auto* bytes{ reinterpret_cast<const std::byte*>(&value) };
        data.insert(data.end(), bytes, bytes + sizeof(value));
    };

    put(std::uint8_t{ 1 });
    put(slots);
    put(static_cast<std::uint16_t>(items.size()));
    for (const auto& [id, amount] : items) {
        put(id);
        put(amount);
        put(std::uint8_t{ 0 });
    }

    return data;
}

Inventory make_inventory(const std::vector<std::pair<std::uint16_t, std::uint8_t>>& items)
{
    Inventory inventory{};
    EXPECT_TRUE(inventory.parse(inventory_payload(items)));
    return inventory;
}
}

TEST(InventoryTest, ParsesInventoryState)
{
    const auto inventory{ make_inventory({ { 2, 200 }, { locks::WORLD_LOCK, 37 }, { locks::DIAMOND_LOCK, 3 } }) };

    EXPECT_TRUE(inventory.is_known());
    EXPECT_EQ(inventory.get_slot_count(), 36u);
    EXPECT_EQ(inventory.get(2), 200);
    EXPECT_EQ(inventory.get(locks::WORLD_LOCK), 37);
    EXPECT_EQ(inventory.get(locks::DIAMOND_LOCK), 3);
    EXPECT_EQ(inventory.get(locks::BLUE_GEM_LOCK), 0);
}

TEST(InventoryTest, RejectsTruncatedData)
{
    auto data{ inventory_payload({ { 2, 10 }, { 4, 20 } }) };
    data.pop_back();

    Inventory inventory{};
    EXPECT_FALSE(inventory.parse(data));
    EXPECT_FALSE(inventory.is_known());
    EXPECT_FALSE(inventory.parse({}));
}

TEST(InventoryTest, AddAndSetClampToStackLimits)
{
    Inventory inventory{};
    inventory.add(locks::WORLD_LOCK, 150);
    inventory.add(locks::WORLD_LOCK, 100);
    EXPECT_EQ(inventory.get(locks::WORLD_LOCK), Inventory::MAX_STACK);

    inventory.add(locks::WORLD_LOCK, -500);
    EXPECT_EQ(inventory.get(locks::WORLD_LOCK), 0);
    EXPECT_FALSE(inventory.get_items().contains(locks::WORLD_LOCK));
}

TEST(LockConversionTest, NoConversionWhenEnoughOrUnknown)
{
    EXPECT_FALSE(locks::plan_conversion(locks::WORLD_LOCK, 50, Inventory{}).has_value());
    EXPECT_FALSE(locks::plan_conversion(locks::WORLD_LOCK, 50, make_inventory({ { locks::WORLD_LOCK, 50 }, { locks::DIAMOND_LOCK, 5 } })).has_value());
}

TEST(LockConversionTest, ShattersJustEnoughHigherLocks)
{
    const auto one{ locks::plan_conversion(locks::WORLD_LOCK, 150, make_inventory({ { locks::WORLD_LOCK, 50 }, { locks::DIAMOND_LOCK, 3 } })) };
    ASSERT_TRUE(one.has_value());
    EXPECT_EQ(one->source_item, locks::DIAMOND_LOCK);
    EXPECT_EQ(one->count, 1);

    const auto two{ locks::plan_conversion(locks::WORLD_LOCK, 180, make_inventory({ { locks::DIAMOND_LOCK, 2 } })) };
    ASSERT_TRUE(two.has_value());
    EXPECT_EQ(two->count, 2);

    const auto blue{ locks::plan_conversion(locks::DIAMOND_LOCK, 10, make_inventory({ { locks::BLUE_GEM_LOCK, 1 } })) };
    ASSERT_TRUE(blue.has_value());
    EXPECT_EQ(blue->source_item, locks::BLUE_GEM_LOCK);
    EXPECT_EQ(blue->count, 1);
}

TEST(LockConversionTest, RefusesUnsafeOrImpossibleConversions)
{
    // Not enough of the higher tier.
    EXPECT_FALSE(locks::plan_conversion(locks::WORLD_LOCK, 150, make_inventory({ { locks::WORLD_LOCK, 10 }, { locks::DIAMOND_LOCK, 1 } })).has_value());
    // Would go over the 200 stack limit.
    EXPECT_FALSE(locks::plan_conversion(locks::WORLD_LOCK, 160, make_inventory({ { locks::WORLD_LOCK, 150 }, { locks::DIAMOND_LOCK, 1 } })).has_value());
    // 100 or more Diamond Locks would be compressed instead of shattered.
    EXPECT_FALSE(locks::plan_conversion(locks::WORLD_LOCK, 50, make_inventory({ { locks::DIAMOND_LOCK, 100 } })).has_value());
    // Nothing above Blue Gem Locks.
    EXPECT_FALSE(locks::plan_conversion(locks::BLUE_GEM_LOCK, 1, make_inventory({})).has_value());
}

TEST(LockConversionTest, ValueInWorldLocks)
{
    EXPECT_EQ(locks::value_in_world_locks(37, 2, 1), 37 + 200 + 10000);
}
