#pragma once
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "../player/player.hpp"
#include "../utils/color_codes.hpp"

namespace world {
struct PlayerMatch {
    int32_t net_id{ -1 };
    std::string name; // Colour codes removed.
};

// Lower-cases a player name and drops colour codes and the leading "@" mods have.
[[nodiscard]] inline std::string normalize_player_name(const std::string_view name)
{
    std::string normalized{ utils::strip_color_codes(name) };
    std::erase_if(normalized, [](const unsigned char c) { return std::isspace(c); });
    while (!normalized.empty() && normalized.front() == '@') {
        normalized.erase(normalized.begin());
    }

    std::ranges::transform(normalized, normalized.begin(), [](const unsigned char c) { return std::tolower(c); });
    return normalized;
}

// Finds players by name, ignoring case and colour codes. An exact match wins;
// otherwise every player whose name starts with `query` is returned.
[[nodiscard]] inline std::vector<PlayerMatch> find_players_by_name(
    const std::unordered_map<int32_t, std::shared_ptr<player::Player>>& players,
    const std::string_view query,
    const int32_t exclude_net_id
) {
    const std::string wanted{ normalize_player_name(query) };
    if (wanted.empty()) {
        return {};
    }

    std::vector<PlayerMatch> prefix_matches{};
    for (const auto& [net_id, player] : players) {
        if (net_id == exclude_net_id || !player) {
            continue;
        }

        const std::string name{ normalize_player_name(player->name()) };
        PlayerMatch match{ net_id, utils::strip_color_codes(player->name()) };
        if (name == wanted) {
            return { std::move(match) };
        }

        if (name.starts_with(wanted)) {
            prefix_matches.push_back(std::move(match));
        }
    }

    std::ranges::sort(prefix_matches, {}, &PlayerMatch::name);
    return prefix_matches;
}
}
