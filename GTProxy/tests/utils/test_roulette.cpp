#include <gtest/gtest.h>
#include "utils/roulette.hpp"

using namespace utils::roulette;

TEST(RouletteTest, StripsColorCodes)
{
    EXPECT_EQ(strip_color_codes("`7[```wPlayer`` got `422``!`7]``"), "[Player got 22!]");
    EXPECT_EQ(strip_color_codes("plain"), "plain");
    EXPECT_EQ(strip_color_codes("trailing`"), "trailing");
}

TEST(RouletteTest, ParsesServerSpinMessage)
{
    const auto spin{ parse_spin_message("`7[```wPlayer`` spun the wheel and got `422``!`7]``") };

    ASSERT_TRUE(spin.has_value());
    EXPECT_EQ(spin->spinner, "Player");
    EXPECT_EQ(spin->number, 22);
    EXPECT_EQ(spin->color_code, "`4");
}

TEST(RouletteTest, ParsesMessageWithoutColorCodes)
{
    const auto spin{ parse_spin_message("[Some Player spun the wheel and got 0!]") };

    ASSERT_TRUE(spin.has_value());
    EXPECT_EQ(spin->spinner, "Some Player");
    EXPECT_EQ(spin->number, 0);
    EXPECT_EQ(spin->color_code, "`2");
}

TEST(RouletteTest, FallsBackToWheelColors)
{
    EXPECT_EQ(parse_spin_message("A spun the wheel and got 1!")->color_code, "`4");
    EXPECT_EQ(parse_spin_message("A spun the wheel and got 2!")->color_code, "`b");
    EXPECT_EQ(parse_spin_message("A spun the wheel and got 36!")->color_code, "`4");
}

TEST(RouletteTest, RejectsOtherMessages)
{
    EXPECT_FALSE(parse_spin_message("Hello world").has_value());
    EXPECT_FALSE(parse_spin_message("A spun the wheel and got !").has_value());
    EXPECT_FALSE(parse_spin_message("A spun the wheel and got 37!").has_value());
    EXPECT_FALSE(parse_spin_message("A spun the wheel and got 123!").has_value());
}
