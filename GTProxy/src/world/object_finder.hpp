#pragma once
#include <algorithm>
#include <vector>
#include <glm/glm.hpp>

#include "object.hpp"

namespace world {
constexpr float TILE_SIZE{ 32.0f };

// Returns the objects within `range_tiles` tiles of `position` (in pixels),
// nearest first. Distances are measured between the raw positions, so they are
// accurate to within a tile, which is enough for pickup range checks.
[[nodiscard]] inline std::vector<const Object*> find_objects_in_range(
    const std::vector<Object>& objects,
    const glm::vec2& position,
    const float range_tiles
) {
    const float max_distance{ range_tiles * TILE_SIZE };

    std::vector<std::pair<float, const Object*>> in_range{};
    for (const auto& object : objects) {
        if (const float distance{ glm::distance(object.pos, position) }; distance <= max_distance) {
            in_range.emplace_back(distance, &object);
        }
    }

    std::ranges::stable_sort(in_range, {}, &std::pair<float, const Object*>::first);

    std::vector<const Object*> result{};
    result.reserve(in_range.size());
    for (const auto& [distance, object] : in_range) {
        result.push_back(object);
    }

    return result;
}
}
