#pragma once
#include <string>
#include <string_view>

namespace utils {
// Removes Growtopia colour codes: a backtick followed by one character.
[[nodiscard]] inline std::string strip_color_codes(const std::string_view text)
{
    std::string result{};
    result.reserve(text.size());
    for (std::size_t i{ 0 }; i < text.size(); ++i) {
        if (text[i] == '`') {
            ++i;
            continue;
        }

        result += text[i];
    }

    return result;
}
}
