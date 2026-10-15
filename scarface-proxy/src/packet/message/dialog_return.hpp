#pragma once
#include <string>

#include "../packet_helper.hpp"

namespace packet::message {
// Client -> server "action|dialog_return\ndialog_name|<name>\n<field>|<value>...":
// what the client sends when it submits a dialog. The proxy uses it to read
// back its own injected dialogs (e.g. the /proxy options menu). `text_parse`
// (from the base) holds every field, so handlers can read checkbox/input values.
struct DialogReturn : TextPacket<PacketId::DialogReturn, NET_MESSAGE_GENERIC_TEXT> {
    std::string dialog_name;

    bool read(const Payload& payload) override
    {
        const auto text_payload{ get_payload_if<TextPayload>(payload) };
        if (!text_payload) {
            return false;
        }

        text_parse = text_payload->data;
        dialog_name = text_parse.get<std::string>("dialog_name");
        return true;
    }

    Payload write() override
    {
        // Not used on the forward path (the original bytes are forwarded); kept
        // valid so the packet satisfies IPacket.
        return TextPayload{ MESSAGE_TYPE, text_parse };
    }
};
}
