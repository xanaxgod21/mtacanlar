#pragma once
#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../packet_helper.hpp"
#include "../../utils/text_parse.hpp"

namespace packet::game {
struct DialogInfo {
    std::string name;
    std::vector<std::pair<std::string, std::string>> embed_data;
    // "add_text_input|<name>|<label>|<default value>|..." as name -> default value.
    std::vector<std::pair<std::string, std::string>> text_inputs;
    // "add_button|<name>|<label>|..." names.
    std::vector<std::string> buttons;

    [[nodiscard]] std::optional<std::string> get_text_input(const std::string_view input_name) const
    {
        for (const auto& [name, value] : text_inputs) {
            if (name == input_name) {
                return value;
            }
        }

        return std::nullopt;
    }

    [[nodiscard]] bool has_button(const std::string_view button_name) const
    {
        return std::ranges::find(buttons, button_name) != buttons.end();
    }

    [[nodiscard]] std::optional<std::string> get_embed_data(const std::string_view key) const
    {
        for (const auto& [embed_key, value] : embed_data) {
            if (embed_key == key) {
                return value;
            }
        }

        return std::nullopt;
    }
};

// Extracts the dialog name (from "end_dialog|<name>|..."), the
// "embed_data|<key>|<value>" lines the client has to send back, the text
// inputs with their default values and the button names.
[[nodiscard]] inline DialogInfo parse_dialog(const std::string_view dialog)
{
    DialogInfo info{};
    for (const auto& line : utils::TextParse::tokenize(dialog, "\n")) {
        const auto tokens{ utils::TextParse::tokenize(line, "|") };
        if (tokens.size() < 2) {
            continue;
        }

        if (tokens[0] == "end_dialog") {
            info.name = tokens[1];
        }
        else if (tokens[0] == "embed_data" && tokens.size() >= 3) {
            info.embed_data.emplace_back(tokens[1], tokens[2]);
        }
        else if (tokens[0] == "add_text_input" && tokens.size() >= 4) {
            info.text_inputs.emplace_back(tokens[1], tokens[3]);
        }
        else if (tokens[0] == "add_button") {
            info.buttons.emplace_back(tokens[1]);
        }
    }

    return info;
}

// Builds the text the client sends when a dialog is submitted, echoing the
// dialog's embedded data followed by the given input fields.
[[nodiscard]] inline std::string make_dialog_return(
    const DialogInfo& dialog,
    const std::vector<std::pair<std::string, std::string>>& fields
) {
    std::string text{ "action|dialog_return\ndialog_name|" + dialog.name };
    for (const auto& [key, value] : dialog.embed_data) {
        text += "\n" + key + "|" + value + "|";
    }

    for (const auto& [key, value] : fields) {
        text += "\n" + key + "|" + value;
    }

    return text;
}

struct OnDialogRequest : VariantPacket<PacketId::OnDialogRequest> {
    std::string dialog;

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

        dialog = variant.get<std::string>(1);
        return true;
    }

    Payload write() override
    {
        const PacketVariant variant{
            "OnDialogRequest",
            dialog
        };
        return VariantPayload{ game_packet, variant };
    }
};
}
