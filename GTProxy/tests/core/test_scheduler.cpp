#include <atomic>
#include <chrono>
#include <thread>
#include <gtest/gtest.h>
#include "core/scheduler.hpp"

using namespace std::chrono_literals;

TEST(SchedulerTest, ShortDelayIsNotHeldBackByALongerPendingTask)
{
    core::Scheduler scheduler{ 2 };
    std::atomic<bool> long_done{ false };
    std::atomic<bool> short_done{ false };

    scheduler.schedule_delayed([&] { long_done = true; }, 2000ms);
    std::this_thread::sleep_for(50ms); // let the timer thread start waiting for the long task
    const auto start{ std::chrono::steady_clock::now() };
    scheduler.schedule_delayed([&] { short_done = true; }, 100ms);

    while (!short_done && std::chrono::steady_clock::now() - start < 1500ms) {
        std::this_thread::sleep_for(5ms);
    }

    EXPECT_TRUE(short_done);
    EXPECT_LT(std::chrono::steady_clock::now() - start, 1000ms);
    EXPECT_FALSE(long_done);
    scheduler.stop();
}

TEST(SchedulerTest, MainThreadTasksRunWhenDrained)
{
    core::Scheduler scheduler{ 1 };
    int runs{ 0 };
    scheduler.post_to_main_thread([&] { ++runs; });
    scheduler.post_to_main_thread([&] { ++runs; });

    EXPECT_EQ(runs, 0);
    scheduler.run_main_thread_tasks();
    EXPECT_EQ(runs, 2);
    scheduler.run_main_thread_tasks();
    EXPECT_EQ(runs, 2);
    scheduler.stop();
}
