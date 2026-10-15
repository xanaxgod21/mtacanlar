#pragma once
#include <chrono>
#include <cstddef>
#include <memory>

#include "../config.hpp"
#include "../scheduler.hpp"
#include "../../network/server.hpp"

namespace core::handlers {
// Posts a short "fun fact" to the game console every few minutes while enabled.
// The toggle is saved to config.json. Purely cosmetic: it only sends Log
// messages to the player, it never touches the game server.
class FunFactsHandler {
public:
    FunFactsHandler(std::shared_ptr<Scheduler> scheduler, network::Server& server, Config& config);

    FunFactsHandler(const FunFactsHandler&) = delete;
    FunFactsHandler& operator=(const FunFactsHandler&) = delete;
    FunFactsHandler(FunFactsHandler&&) noexcept = delete;
    FunFactsHandler& operator=(FunFactsHandler&&) noexcept = delete;
    ~FunFactsHandler();

    [[nodiscard]] bool is_enabled() const { return config_.get_feature_config().fun_facts; }
    void set_enabled(bool enabled);

private:
    static constexpr auto INTERVAL{ std::chrono::minutes{ 4 } };
    static constexpr auto INITIAL_DELAY{ std::chrono::seconds{ 30 } };
    static constexpr const char* TASK_TAG{ "funfacts" };

    void start();
    void stop();
    void tick();

    std::shared_ptr<Scheduler> scheduler_;
    network::Server& server_;
    Config& config_;

    std::size_t next_index_{ 0 };
    TaskId task_id_{ INVALID_TASK_ID };
};
}
