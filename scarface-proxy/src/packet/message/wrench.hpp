#pragma once
#include <cstdint>
#include <string>

#include "../packet_helper.hpp"

namespace packet::message {
// Client -> server "action|wrench\n|netid|<id>": the player wrenched someone or
// something in the world. For a player the net id is theirs; tiles send -1.
struct Wrench : TextPacket<PacketId::Wrench, NET_MESSAGE_GENERIC_TEXT> {
    int32_t net_id{ -1 };

    bool read(const Payload& payload) override
    {
        const auto text_payload{ get_payload_if<TextPayload>(payload) };
        if (!text_payload) {
            return false;
        }

        text_parse = text_payload->data;
        net_id = text_parse.get<int32_t>("netid");
        return true;
    }

    Payload write() override
    {
        utils::TextParse parse{};
        parse.add("action", "wrench");
        parse.add("", "netid", net_id);
        return TextPayload{ MESSAGE_TYPE, parse };
    }
};
}
