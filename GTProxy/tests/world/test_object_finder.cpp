#include <gtest/gtest.h>
#include "world/object_finder.hpp"

using namespace world;

namespace {
Object make_object(const std::uint32_t object_id, const float x, const float y)
{
    Object obj{};
    obj.object_id = object_id;
    obj.pos = glm::vec2{ x, y };
    return obj;
}
}

TEST(ObjectFinderTest, ReturnsOnlyObjectsInRangeNearestFirst)
{
    const std::vector<Object> objects{
        make_object(1, 100.0f, 0.0f),  // 100px away
        make_object(2, 10.0f, 0.0f),   // 10px away
        make_object(3, 500.0f, 0.0f),  // out of range
        make_object(4, 0.0f, 40.0f),   // 40px away
    };

    const auto found{ find_objects_in_range(objects, glm::vec2{ 0.0f, 0.0f }, 4.0f) };

    ASSERT_EQ(found.size(), 3u);
    EXPECT_EQ(found[0]->object_id, 2u);
    EXPECT_EQ(found[1]->object_id, 4u);
    EXPECT_EQ(found[2]->object_id, 1u);
}

TEST(ObjectFinderTest, RangeIsMeasuredInTilesAndInclusive)
{
    const std::vector<Object> objects{
        make_object(1, 64.0f, 0.0f),
        make_object(2, 64.1f, 0.0f),
    };

    const auto found{ find_objects_in_range(objects, glm::vec2{ 0.0f, 0.0f }, 2.0f) };

    ASSERT_EQ(found.size(), 1u);
    EXPECT_EQ(found[0]->object_id, 1u);
}

TEST(ObjectFinderTest, EmptyWhenNothingNearby)
{
    const std::vector<Object> objects{ make_object(1, 1000.0f, 1000.0f) };

    EXPECT_TRUE(find_objects_in_range(objects, glm::vec2{ 0.0f, 0.0f }, 5.0f).empty());
    EXPECT_TRUE(find_objects_in_range({}, glm::vec2{ 0.0f, 0.0f }, 5.0f).empty());
}
