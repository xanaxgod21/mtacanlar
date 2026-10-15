#include <gtest/gtest.h>
#include "world/player_finder.hpp"

using namespace world;

namespace {
std::shared_ptr<player::Player> make_player(const int32_t net_id, const std::string& name)
{
    packet::game::OnSpawn spawn{};
    spawn.net_id = net_id;
    spawn.name = name;
    return player::Player::from_on_spawn(spawn);
}

std::unordered_map<int32_t, std::shared_ptr<player::Player>> make_players()
{
    return {
        { 1, make_player(1, "`wMe``") },
        { 2, make_player(2, "`wAlice``") },
        { 3, make_player(3, "`wAlicia``") },
        { 4, make_player(4, "`#@Bob``") },
    };
}
}

TEST(PlayerFinderTest, ExactMatchIgnoresCaseAndColors)
{
    const auto matches{ find_players_by_name(make_players(), "alice", 1) };
    ASSERT_EQ(matches.size(), 1u);
    EXPECT_EQ(matches[0].net_id, 2);
    EXPECT_EQ(matches[0].name, "Alice");
}

TEST(PlayerFinderTest, PrefixMatchesAreAllReturned)
{
    const auto matches{ find_players_by_name(make_players(), "ali", 1) };
    ASSERT_EQ(matches.size(), 2u);
    EXPECT_EQ(matches[0].name, "Alice");
    EXPECT_EQ(matches[1].name, "Alicia");
}

TEST(PlayerFinderTest, ModAtPrefixAndSelfAreHandled)
{
    const auto bob{ find_players_by_name(make_players(), "bob", 1) };
    ASSERT_EQ(bob.size(), 1u);
    EXPECT_EQ(bob[0].net_id, 4);

    EXPECT_TRUE(find_players_by_name(make_players(), "me", 1).empty());
    EXPECT_TRUE(find_players_by_name(make_players(), "zed", 1).empty());
    EXPECT_TRUE(find_players_by_name(make_players(), "", 1).empty());
}
