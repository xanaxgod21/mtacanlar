#pragma once
#include <string>
#include <vector>

#include "../packet/game/world.hpp"
#include "../utils/color_codes.hpp"

namespace player {
// Why a spawned player looks like Growtopia staff; empty for ordinary players.
[[nodiscard]] inline std::vector<std::string> staff_reasons(const packet::game::OnSpawn& spawn)
{
    std::vector<std::string> reasons{};
    if (spawn.mod_state > 0) {
        reasons.emplace_back("mod");
    }

    if (spawn.supermod_state > 0) {
        reasons.emplace_back("super mod");
    }

    if (spawn.invisible > 0) {
        reasons.emplace_back("invisible");
    }

    // Staff names are shown with an "@" in front.
    if (utils::strip_color_codes(spawn.name).starts_with('@')) {
        reasons.emplace_back("@ name");
    }

    return reasons;
}
}
