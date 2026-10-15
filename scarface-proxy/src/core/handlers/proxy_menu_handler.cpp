#include "proxy_menu_handler.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <tuple>

#include <fmt/format.h>
#include <spdlog/spdlog.h>

#include "../../packet/game/dialog.hpp"
#include "../../packet/message/chat.hpp"
#include "../../packet/message/dialog_return.hpp"
#include "../../packet/packet_helper.hpp"

namespace core::handlers {
namespace {
    constexpr auto dialog_return_type{ event::packet_event_type(packet::PacketId::DialogReturn) };

    [[nodiscard]] std::string_view onoff(const bool enabled)
    {
        return enabled ? "1" : "0";
    }
}

ProxyMenuHandler::ProxyMenuHandler(
    event::Dispatcher& dispatcher,
    network::Server& server,
    QuickWrenchHandler& quick_wrench,
    RouletteHandler& roulette,
    ModAlertHandler& mod_alert,
    FunFactsHandler& fun_facts,
    FastDropHandler& fast_drop,
    AutoCollectHandler& auto_collect,
    HotkeyHandler& hotkey,
    PathfindHandler& pathfind
)
    : dispatcher_{ dispatcher }
    , server_{ server }
    , quick_wrench_{ quick_wrench }
    , roulette_{ roulette }
    , mod_alert_{ mod_alert }
    , fun_facts_{ fun_facts }
    , fast_drop_{ fast_drop }
    , auto_collect_{ auto_collect }
    , hotkey_{ hotkey }
    , pathfind_{ pathfind }
{
    handle_ = event::ScopedHandle{
        dispatcher_,
        dialog_return_type,
        dispatcher_.append_listener(dialog_return_type, [this](const event::Event& e) { on_dialog_return(e); })
    };
}

std::string ProxyMenuHandler::build_dialog() const
{
    std::string d{};
    d += "set_default_color|`o\n";
    d += "add_label_with_icon|big|`wScarface Proxy``|left|32|\n";
    d += "add_spacer|small|\n";
    d += fmt::format("add_checkbox|cb_wrench|`wWrench Pull``|{}\n", onoff(quick_wrench_.is_enabled()));
    d += fmt::format("add_checkbox|cb_spin|`wShow Real/Fake Spin``|{}\n", onoff(roulette_.is_enabled()));
    d += fmt::format("add_text_input|ti_rmode|Roulette mode (real/reme/qq)|{}|4\n", roulette_.mode_string());
    d += fmt::format("add_checkbox|cb_modalert|`wAuto Mod Detect``|{}\n", onoff(mod_alert_.is_enabled()));
    d += fmt::format("add_checkbox|cb_funfacts|`wShow Fun Facts``|{}\n", onoff(fun_facts_.is_enabled()));
    d += fmt::format("add_checkbox|cb_fastdrop|`wFast Drop``|{}\n", onoff(fast_drop_.is_enabled()));
    d += fmt::format("add_checkbox|cb_autocollect|`wAuto Collect``|{}\n", onoff(auto_collect_.is_enabled()));
    d += fmt::format("add_checkbox|cb_collectkey|`wAuto Collect Keybind``|{}\n", onoff(hotkey_.is_enabled()));
    d += fmt::format("add_text_input|ti_collectkey|Keybind Key|{}|6\n", HotkeyHandler::name_from_key(hotkey_.get_key()));
    d += fmt::format("add_checkbox|cb_pathfind|`wPathfind (click to teleport)``|{}\n", onoff(pathfind_.is_enabled()));
    d += "add_spacer|small|\n";
    d += "add_textbox|`oMore features coming soon.``|left|\n";
    d += "end_dialog|scarface_options|Close|Save|\n";
    return d;
}

void ProxyMenuHandler::open() const
{
    packet::game::OnDialogRequest pkt{};
    pkt.dialog = build_dialog();
    std::ignore = packet::PacketHelper::write(pkt, server_);
}

void ProxyMenuHandler::on_dialog_return(const event::Event& event)
{
    const auto* evt{ dynamic_cast<const event::TypedPacketEvent<packet::PacketId::DialogReturn>*>(&event) };
    if (!evt || evt->direction != event::Direction::ServerBound) {
        return;
    }

    const auto pkt{ evt->get<packet::message::DialogReturn>() };
    if (!pkt || pkt->dialog_name != DIALOG_NAME) {
        return;
    }

    // Our own injected dialog: apply it and keep it from reaching the server.
    evt->cancel();

    const auto apply{ [&pkt](const char* key, auto& handler) {
        const auto raw{ pkt->text_parse.get<std::string>(key) };
        if (raw.empty()) {
            return; // Field absent: leave this feature unchanged.
        }

        handler.set_enabled(raw == "1");
    } };

    apply("cb_wrench", quick_wrench_);
    apply("cb_spin", roulette_);
    apply("cb_modalert", mod_alert_);
    apply("cb_funfacts", fun_facts_);
    apply("cb_fastdrop", fast_drop_);
    apply("cb_autocollect", auto_collect_);
    apply("cb_collectkey", hotkey_);
    apply("cb_pathfind", pathfind_);

    if (const auto key_name{ pkt->text_parse.get<std::string>("ti_collectkey") }; !key_name.empty()) {
        if (const int vk{ HotkeyHandler::key_from_name(key_name) }; vk > 0) {
            hotkey_.set_key(vk);
        }
    }

    if (auto rmode{ pkt->text_parse.get<std::string>("ti_rmode") }; !rmode.empty()) {
        std::ranges::transform(rmode, rmode.begin(), [](const unsigned char c) { return std::tolower(c); });
        if (rmode == "real" || rmode == "reme" || rmode == "qq") {
            roulette_.set_mode_from_string(rmode);
        }
    }

    spdlog::info("Proxy menu: settings applied");
    send_log("`2Scarface Proxy ayarlari kaydedildi.");
}

void ProxyMenuHandler::send_log(const std::string& msg) const
{
    packet::message::Log log_pkt{};
    log_pkt.msg = msg;
    std::ignore = packet::PacketHelper::write(log_pkt, server_);
}
}
