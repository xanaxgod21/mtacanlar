#pragma once
#include <string>

#include "../packet_helper.hpp"

namespace packet::message {
// Client -> server login blob (GENERIC_TEXT) sent right after ServerHello. It
// carries the real Growtopia client's "game_version|X.XX" and "protocol|NNN"
// among many other fields. The proxy never rewrites it (the original bytes are
// forwarded untouched); it only reads the version so it can follow whatever
// version the installed client reports, instead of a value hard-coded in config.
struct LoginRequest : TextPacket<PacketId::LoginRequest, NET_MESSAGE_GENERIC_TEXT> {
    std::string game_version;
    int protocol{ 0 };

    bool read(const Payload& payload) override
    {
        const auto text_payload{ get_payload_if<TextPayload>(payload) };
        if (!text_payload) {
            return false;
        }

        text_parse = text_payload->data;
        game_version = text_parse.get<std::string>("game_version");
        protocol = text_parse.get<int>("protocol");
        return true;
    }

    Payload write() override
    {
        // Forward path uses the original bytes; kept valid for IPacket only.
        return TextPayload{ MESSAGE_TYPE, text_parse };
    }
};
}
