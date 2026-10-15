#pragma once
#include "../config.hpp"
#include "../../event/event.hpp"
#include "../../network/client.hpp"

namespace core::handlers {
// While enabled, answers the "how many?" (drop_item) dialog automatically so
// dropping an item needs no dialog. The amount is config.fast_drop_amount
// (0 = drop everything). `/count <n>` sets it. Toggle and amount are saved to
// config.json.
//
// It runs after DialogInterceptor, so a drop started by a proxy command (e.g.
// /wd) is handled by that command's expectation and never reaches here.
class FastDropHandler {
public:
    FastDropHandler(event::Dispatcher& dispatcher, network::Client& client, Config& config);

    FastDropHandler(const FastDropHandler&) = delete;
    FastDropHandler& operator=(const FastDropHandler&) = delete;
    FastDropHandler(FastDropHandler&&) noexcept = delete;
    FastDropHandler& operator=(FastDropHandler&&) noexcept = delete;
    ~FastDropHandler() = default;

    [[nodiscard]] bool is_enabled() const { return config_.get_feature_config().fast_drop; }
    void set_enabled(bool enabled);

    [[nodiscard]] int get_amount() const { return config_.get_feature_config().fast_drop_amount; }
    void set_amount(int amount);

private:
    void on_dialog(const event::Event& event);

    event::Dispatcher& dispatcher_;
    network::Client& client_;
    Config& config_;

    event::ScopedHandle handle_;
};
}
