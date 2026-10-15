#include <gtest/gtest.h>
#include "packet/packet_id.hpp"

using namespace packet;

namespace {
PacketId text_id(const std::string& text)
{
    return derive_packet_id(TextPayload{ NET_MESSAGE_GENERIC_TEXT, utils::TextParse{ text } });
}
}

TEST(PacketIdTest, RecognizesSingleLineActions)
{
    EXPECT_EQ(text_id("action|quit"), PacketId::Quit);
    EXPECT_EQ(text_id("action|quit_to_exit"), PacketId::QuitToExit);
}

TEST(PacketIdTest, RecognizesMultiLineActions)
{
    EXPECT_EQ(text_id("action|join_request\nname|START\ninvitedWorld|0"), PacketId::JoinRequest);
    EXPECT_EQ(text_id("action|validate_world\nname|START"), PacketId::ValidateWorld);
    EXPECT_EQ(text_id("action|log\nmsg|hello"), PacketId::Log);
    EXPECT_EQ(text_id("action|input\n|text|hello"), PacketId::Input);
}

TEST(PacketIdTest, DoesNotMatchLongerActionNames)
{
    EXPECT_EQ(text_id("action|quit_to_exit\nfoo|bar"), PacketId::QuitToExit);
    EXPECT_EQ(text_id("action|logout"), PacketId::Unknown);
    EXPECT_EQ(text_id("action|drop\n|itemID|242"), PacketId::Unknown);
}
