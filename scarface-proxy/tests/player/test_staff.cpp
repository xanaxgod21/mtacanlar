#include <gtest/gtest.h>
#include "player/staff.hpp"

TEST(StaffTest, OrdinaryPlayerIsNotStaff)
{
    packet::game::OnSpawn spawn{};
    spawn.name = "`wPlayer``";
    EXPECT_TRUE(player::staff_reasons(spawn).empty());
}

TEST(StaffTest, DetectsModFlagsAndAtName)
{
    packet::game::OnSpawn spawn{};
    spawn.name = "`#@SomeMod``";
    spawn.mod_state = 1;
    spawn.invisible = 1;

    const auto reasons{ player::staff_reasons(spawn) };
    EXPECT_EQ(reasons, (std::vector<std::string>{ "mod", "invisible", "@ name" }));
}
