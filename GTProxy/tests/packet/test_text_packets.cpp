#include <gtest/gtest.h>
#include "packet/message/chat.hpp"
#include "packet/message/exit.hpp"
#include "packet/message/input.hpp"
#include "packet/message/raw_text.hpp"

using namespace packet;

namespace {
// Same as the decoder: the text is parsed into a TextParse and handed to read().
template <typename Packet>
Packet read_text(const std::string& text)
{
    Packet pkt{};
    EXPECT_TRUE(pkt.read(TextPayload{ NET_MESSAGE_GENERIC_TEXT, utils::TextParse{ text } }));
    return pkt;
}
}

TEST(TextPacketTest, InputReadsChatTextAsTheClientSendsIt)
{
    EXPECT_EQ(read_text<message::Input>("action|input\n|text|/wd 10").text, "/wd 10");
}

TEST(TextPacketTest, LogReadsMessage)
{
    EXPECT_EQ(read_text<message::Log>("action|log\nmsg|hello world").msg, "hello world");
}

TEST(TextPacketTest, JoinRequestReadsWorldName)
{
    const auto pkt{ read_text<message::JoinRequest>("action|join_request\nname|START\ninvitedWorld|0") };
    EXPECT_EQ(pkt.world_name, "START");
    EXPECT_FALSE(pkt.invited_world);
}

TEST(TextPacketTest, ValidateWorldReadsWorldName)
{
    EXPECT_EQ(read_text<message::ValidateWorld>("action|validate_world\nname|START").world_name, "START");
}

TEST(TextPacketTest, RawTextKeepsTheExactText)
{
    const auto data{ message::make_raw_text(NET_MESSAGE_GENERIC_TEXT, "action|drop\n|itemID|242") };

    ASSERT_EQ(data.size(), 4u + 23u + 1u);
    EXPECT_EQ(static_cast<std::uint8_t>(data[0]), NET_MESSAGE_GENERIC_TEXT);
    EXPECT_EQ(std::string(reinterpret_cast<const char*>(data.data()) + 4, 23), "action|drop\n|itemID|242");
    EXPECT_EQ(data.back(), std::byte{ 0 });
}
