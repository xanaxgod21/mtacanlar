project(GTProxy_tests)

find_package(GTest REQUIRED)
find_package(fmt REQUIRED)
find_package(glm REQUIRED)
find_package(magic_enum REQUIRED)
find_package(spdlog REQUIRED)

add_executable(GTProxy_tests
    core/test_scheduler.cpp
    ${CMAKE_SOURCE_DIR}/src/core/scheduler.cpp
    packet/test_dialog.cpp
    packet/test_game_packets.cpp
    packet/test_packet_id.cpp
    packet/test_text_packets.cpp
    player/test_inventory.cpp
    player/test_staff.cpp
    utils/test_text_parse.cpp
    utils/test_byte_stream.cpp
    utils/test_roulette.cpp
    world/test_object_finder.cpp
    world/test_player_finder.cpp)

target_include_directories(GTProxy_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/src)

target_link_libraries(GTProxy_tests PRIVATE
    GTest::gtest_main
    fmt::fmt
    glm::glm
    magic_enum::magic_enum
    spdlog::spdlog)

target_compile_definitions(GTProxy_tests PRIVATE
    SPDLOG_FMT_EXTERNAL)

include(GoogleTest)
gtest_discover_tests(GTProxy_tests)
