#include <gtest/gtest.h>
#include "packet/game/dialog.hpp"

using namespace packet;

namespace {
// The drop dialog as the Growtopia server sends it.
constexpr const char* DROP_DIALOG{
    "set_default_color|`o\n"
    "add_label_with_icon|big|`wDrop World Lock``|left|242|\n"
    "add_textbox|How many to drop?|left|\n"
    "add_text_input|count||5|5|\n"
    "embed_data|itemID|242\n"
    "end_dialog|drop_item|Cancel|OK|\n"
};
}

TEST(DialogTest, ParsesNameAndEmbeddedData)
{
    const auto dialog{ game::parse_dialog(DROP_DIALOG) };

    EXPECT_EQ(dialog.name, "drop_item");
    ASSERT_EQ(dialog.embed_data.size(), 1u);
    EXPECT_EQ(dialog.get_embed_data("itemID"), "242");
    EXPECT_FALSE(dialog.get_embed_data("count").has_value());
}

TEST(DialogTest, ParsesTextInputsAndButtons)
{
    const auto drop{ game::parse_dialog(DROP_DIALOG) };
    EXPECT_EQ(drop.get_text_input("count"), "5");
    EXPECT_FALSE(drop.get_text_input("missing").has_value());

    const auto popup{ game::parse_dialog(
        "add_label_with_icon|big|`wBob``|left|18|\n"
        "embed_data|netID|12\n"
        "add_button|pull|`5Pull``|noflags|0|0|\n"
        "add_button|kick|`4Kick``|noflags|0|0|\n"
        "end_dialog|popup||Continue|\n"
    ) };
    EXPECT_EQ(popup.name, "popup");
    EXPECT_TRUE(popup.has_button("pull"));
    EXPECT_TRUE(popup.has_button("kick"));
    EXPECT_FALSE(popup.has_button("worldban"));
    EXPECT_EQ(
        game::make_dialog_return(popup, { { "buttonClicked", "pull" } }),
        "action|dialog_return\ndialog_name|popup\nnetID|12|\nbuttonClicked|pull"
    );
}

TEST(DialogTest, ParsesDialogWithoutTrailingNewline)
{
    const auto dialog{ game::parse_dialog("embed_data|itemID|1796\nend_dialog|drop_item|Cancel|OK|") };

    EXPECT_EQ(dialog.name, "drop_item");
    EXPECT_EQ(dialog.get_embed_data("itemID"), "1796");
}

TEST(DialogTest, BuildsDropDialogReturn)
{
    const auto dialog{ game::parse_dialog(DROP_DIALOG) };

    EXPECT_EQ(
        game::make_dialog_return(dialog, { { "count", "10" } }),
        "action|dialog_return\ndialog_name|drop_item\nitemID|242|\ncount|10"
    );
}

TEST(DialogTest, OnDialogRequestRoundTrip)
{
    game::OnDialogRequest request{};
    request.dialog = DROP_DIALOG;

    game::OnDialogRequest decoded{};
    ASSERT_TRUE(decoded.read(request.write()));
    EXPECT_EQ(decoded.dialog, DROP_DIALOG);
    EXPECT_EQ(decoded.variant.get<std::string>(0), "OnDialogRequest");
}
