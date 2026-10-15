#pragma once
#include <cstdint>
#include <string>
#include <variant>

#include "../packet_helper.hpp"

namespace packet::game {
// Reads an integer variant regardless of whether it was sent signed, unsigned or as a float.
[[nodiscard]] inline int32_t variant_int(const PacketVariant& variant, const std::size_t index)
{
    if (index >= variant.size()) {
        return 0;
    }

    return std::visit([]<typename T>(const T& value) -> int32_t {
        if constexpr (std::is_arithmetic_v<T>) {
            return static_cast<int32_t>(value);
        }
        else {
            return 0;
        }
    }, variant.get_variants()[index]);
}

// Variant packets carry the client-side display delay (milliseconds) in int_data.
[[nodiscard]] inline int32_t variant_delay(const GameUpdatePacket& game_packet)
{
    return game_packet.int_data;
}

struct OnTalkBubble : VariantPacket<PacketId::OnTalkBubble> {
    int32_t net_id{ -1 };
    std::string text;

    bool read(const Payload& payload) override
    {
        const auto var{ get_payload_if<VariantPayload>(payload) };
        if (!var) {
            return false;
        }

        variant = var->variant;
        game_packet = var->game_packet;

        if (variant.size() < 3) {
            return false;
        }

        net_id = variant_int(variant, 1);
        text = variant.get<std::string>(2);
        return true;
    }

    Payload write() override
    {
        const PacketVariant variant{
            "OnTalkBubble",
            net_id,
            text,
            0
        };
        return VariantPayload{ game_packet, variant };
    }
};

struct OnConsoleMessage : VariantPacket<PacketId::OnConsoleMessage> {
    std::string text;

    bool read(const Payload& payload) override
    {
        const auto var{ get_payload_if<VariantPayload>(payload) };
        if (!var) {
            return false;
        }

        variant = var->variant;
        game_packet = var->game_packet;

        if (variant.size() < 2) {
            return false;
        }

        text = variant.get<std::string>(1);
        return true;
    }

    Payload write() override
    {
        const PacketVariant variant{
            "OnConsoleMessage",
            text
        };
        return VariantPayload{ game_packet, variant };
    }
};

// Big text shown in the middle of the screen for a few seconds.
struct OnTextOverlay : VariantPacket<PacketId::OnTextOverlay> {
    std::string text;

    bool read(const Payload& payload) override
    {
        const auto var{ get_payload_if<VariantPayload>(payload) };
        if (!var) {
            return false;
        }

        variant = var->variant;
        game_packet = var->game_packet;

        if (variant.size() < 2) {
            return false;
        }

        text = variant.get<std::string>(1);
        return true;
    }

    Payload write() override
    {
        game_packet.net_id = static_cast<std::uint32_t>(-1);
        const PacketVariant variant{
            "OnTextOverlay",
            text
        };
        return VariantPayload{ game_packet, variant };
    }
};
}
