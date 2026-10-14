#include <cstddef>
#include <cstring>
#include <gtest/gtest.h>
#include "packet/game/player.hpp"
#include "packet/game/world.hpp"

using namespace packet;

namespace {
// Serialized game packets are [NetMessageType (4 bytes)][GameUpdatePacket][extra].
GameUpdatePacket header_of(const std::vector<std::byte>& data)
{
    GameUpdatePacket header{};
    EXPECT_GE(data.size(), sizeof(NetMessageType) + sizeof(GameUpdatePacket));
    std::memcpy(&header, data.data() + sizeof(NetMessageType), sizeof(GameUpdatePacket));
    return header;
}

NetMessageType message_type_of(const std::vector<std::byte>& data)
{
    NetMessageType type{};
    std::memcpy(&type, data.data(), sizeof(type));
    return type;
}
}

TEST(GamePacketTest, GameUpdatePacketLayout)
{
    EXPECT_EQ(sizeof(GameUpdatePacket), 56u);
    EXPECT_EQ(offsetof(GameUpdatePacket, net_id), 4u);
    EXPECT_EQ(offsetof(GameUpdatePacket, item_net_id), 8u);
    EXPECT_EQ(offsetof(GameUpdatePacket, float_var), 16u);
    EXPECT_EQ(offsetof(GameUpdatePacket, int_data), 20u);
    EXPECT_EQ(offsetof(GameUpdatePacket, pos_x), 24u);
    EXPECT_EQ(offsetof(GameUpdatePacket, pos_y), 28u);
}

TEST(GamePacketTest, ItemActivateObjectRequestSerializesPickupFields)
{
    game::ItemActivateObjectRequest request{};
    request.net_id = 7;
    request.pos_x = 321.5f;
    request.pos_y = 654.25f;
    request.object_id = 70000;

    const auto data{ PacketHelper::serialize(request) };

    ASSERT_EQ(data.size(), sizeof(NetMessageType) + sizeof(GameUpdatePacket));
    EXPECT_EQ(message_type_of(data), NET_MESSAGE_GAME_PACKET);

    const auto header{ header_of(data) };
    EXPECT_EQ(header.type, PACKET_ITEM_ACTIVATE_OBJECT_REQUEST);
    EXPECT_EQ(header.net_id, 7u);
    EXPECT_EQ(header.int_data, 70000);
    EXPECT_FLOAT_EQ(header.pos_x, 321.5f);
    EXPECT_FLOAT_EQ(header.pos_y, 654.25f);
    EXPECT_EQ(header.flags.extended, 0u);
}

TEST(GamePacketTest, ItemActivateObjectRequestRoundTrip)
{
    game::ItemActivateObjectRequest request{};
    request.net_id = 3;
    request.pos_x = 10.0f;
    request.pos_y = 20.0f;
    request.object_id = 42;

    game::ItemActivateObjectRequest decoded{};
    ASSERT_TRUE(decoded.read(request.write()));
    EXPECT_EQ(decoded.net_id, 3);
    EXPECT_FLOAT_EQ(decoded.pos_x, 10.0f);
    EXPECT_FLOAT_EQ(decoded.pos_y, 20.0f);
    EXPECT_EQ(decoded.object_id, 42u);
}

TEST(GamePacketTest, ItemChangeObjectReadsNewDrop)
{
    GamePayload payload{};
    payload.packet.type = PACKET_ITEM_CHANGE_OBJECT;
    payload.packet.object_change_type = -1;
    payload.packet.item_id = 242;
    payload.packet.float_var = 200.0f;
    payload.packet.pos_x = 1600.0f;
    payload.packet.pos_y = 800.0f;

    game::ItemChangeObject pkt{};
    ASSERT_TRUE(pkt.read(payload));
    EXPECT_EQ(pkt.object_change_type, -1);
    EXPECT_EQ(pkt.item_id, 242);
    EXPECT_EQ(pkt.amount, 200);
    EXPECT_FLOAT_EQ(pkt.pos_x, 1600.0f);
    EXPECT_FLOAT_EQ(pkt.pos_y, 800.0f);
}

TEST(GamePacketTest, StateReadsPosition)
{
    GamePayload payload{};
    payload.packet.type = PACKET_STATE;
    payload.packet.net_id = 12;
    payload.packet.pos_x = 96.0f;
    payload.packet.pos_y = 128.0f;

    game::State pkt{};
    ASSERT_TRUE(pkt.read(payload));
    EXPECT_EQ(pkt.net_id, 12);
    EXPECT_FLOAT_EQ(pkt.pos_x, 96.0f);
    EXPECT_FLOAT_EQ(pkt.pos_y, 128.0f);
}
