#pragma once
#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <string>
#include <string_view>

#include "color_codes.hpp"

namespace utils::roulette {
struct SpinResult {
    std::string spinner;    // Name of the player who spun, colour codes removed.
    int number{ 0 };        // 0-36
    std::string color_code; // Growtopia colour code of the number, e.g. "`4".
};

using utils::strip_color_codes;

// "Reme" as played in Growtopia casinos: the last digit of the sum of the
// number's digits (22 -> 4, 28 -> 10 -> 0).
[[nodiscard]] constexpr int reme(const int number)
{
    return (number / 10 + number % 10) % 10;
}

// Colour of a number on the wheel, used when the message carries none.
[[nodiscard]] inline std::string_view number_color_code(const int number)
{
    constexpr std::array RED{ 1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36 };
    if (number == 0) {
        return "`2";
    }

    return std::ranges::find(RED, number) != RED.end() ? "`4" : "`b";
}

// Parses the server's roulette message, e.g.
// "`7[```wPlayer`` spun the wheel and got `422``!`7]``".
[[nodiscard]] inline std::optional<SpinResult> parse_spin_message(const std::string_view text)
{
    constexpr std::string_view PHRASE{ " spun the wheel and got " };

    const std::string plain{ strip_color_codes(text) };
    const auto phrase_pos{ plain.find(PHRASE) };
    if (phrase_pos == std::string::npos) {
        return std::nullopt;
    }

    std::size_t digits_begin{ phrase_pos + PHRASE.size() };
    std::size_t digits_end{ digits_begin };
    while (digits_end < plain.size() && std::isdigit(static_cast<unsigned char>(plain[digits_end]))) {
        ++digits_end;
    }

    if (digits_end == digits_begin || digits_end - digits_begin > 2) {
        return std::nullopt;
    }

    SpinResult result{};
    result.number = std::stoi(plain.substr(digits_begin, digits_end - digits_begin));
    if (result.number > 36) {
        return std::nullopt;
    }

    std::string_view spinner{ plain };
    spinner = spinner.substr(0, phrase_pos);
    while (!spinner.empty() && (spinner.front() == '[' || std::isspace(static_cast<unsigned char>(spinner.front())))) {
        spinner.remove_prefix(1);
    }
    while (!spinner.empty() && std::isspace(static_cast<unsigned char>(spinner.back()))) {
        spinner.remove_suffix(1);
    }
    result.spinner = spinner;

    // Keep the colour the server used for the number if it sent one.
    constexpr std::string_view GOT{ "and got " };
    if (const auto got_pos{ text.find(GOT) }; got_pos != std::string_view::npos) {
        const auto code_pos{ got_pos + GOT.size() };
        if (code_pos + 1 < text.size() && text[code_pos] == '`' && text[code_pos + 1] != '`') {
            result.color_code = text.substr(code_pos, 2);
        }
    }

    if (result.color_code.empty()) {
        result.color_code = number_color_code(result.number);
    }

    return result;
}
}
