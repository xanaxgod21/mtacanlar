#pragma once
#include <fmt/format.h>

#include "../packet_helper.hpp"
#include "../../core/branding.hpp"

namespace packet::message {
struct Log : TextPacket<PacketId::Log> {
    std::string msg;

    bool read(const Payload& payload) override
    {
        const auto text{ get_payload_if<TextPayload>(payload) };
        if (!text) {
            return false;
        };

        text_parse = text->data;
        
        msg = text_parse.get("msg", 0);
        return true;
    }

    Payload write() override
    {
        utils::TextParse parse{};
        parse.add("action", "log");
        // Only messages the proxy builds go through write(); the server's own
        // log messages are forwarded as received.
        parse.add("msg", fmt::format("{}{}", core::branding::LOG_PREFIX, msg));
        return TextPayload{ MESSAGE_TYPE, parse };
    }
};
}
