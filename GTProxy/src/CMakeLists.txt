project(ScarfaceProxy)

file(GLOB GTPROXY_INCLUDE_FILES
    *.hpp
    command/*.hpp
    command/commands/*.hpp
    core/*.hpp
    core/handlers/*.hpp
    event/*.hpp
    item/*.hpp
    license/*.hpp
    network/*.hpp
    packet/*.hpp
    packet/game/*.hpp
    packet/message/*.hpp
    player/*.hpp
    scripting/*.hpp
    scripting/bindings/*.hpp
    utils/*.hpp
    utils/formatter/*.hpp
    world/*.hpp)

file(GLOB GTPROXY_SOURCE_FILES
    *.cpp
    command/*.cpp
    core/*.cpp
    core/handlers/*.cpp
    item/*.cpp
    license/*.cpp
    network/*.cpp
    packet/*.cpp
    scripting/*.cpp
    scripting/bindings/*.cpp
    utils/*.cpp
    world/*.cpp)

add_executable(${PROJECT_NAME}
    ${GTPROXY_INCLUDE_FILES}
    ${GTPROXY_SOURCE_FILES})

find_package(eventpp REQUIRED)
find_package(fmt REQUIRED)
find_package(glaze REQUIRED)
find_package(glm REQUIRED)
#find_package(httplib REQUIRED)
find_package(magic_enum REQUIRED)
find_package(pcg-cpp REQUIRED)
find_package(LibreSSL REQUIRED)
find_package(lua REQUIRED)
find_package(sol2 REQUIRED)
find_package(spdlog REQUIRED)
find_package(ZLIB REQUIRED)

target_link_libraries(${PROJECT_NAME}
    enet
    eventpp::eventpp
    fmt::fmt
    glaze::glaze
    glm::glm
    httplib::httplib
    LibreSSL::TLS
    LibreSSL::Crypto
    lua::lua
    magic_enum::magic_enum
    pcg-cpp::pcg-cpp
    sol2::sol2
    spdlog::spdlog
    ZLIB::ZLIB)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_SOURCE_DIR}/lib/enet/include)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_SOURCE_DIR}/lib/libressl/include)

if (MSVC)
    target_compile_options(${PROJECT_NAME} PRIVATE 
        /EHsc
        /bigobj)
else ()
    target_compile_options(${PROJECT_NAME} PRIVATE
        -fexceptions)
endif ()

target_compile_definitions(${PROJECT_NAME} PUBLIC
    NOMINMAX
    WIN32_LEAN_AND_MEAN
    SPDLOG_FMT_EXTERNAL
    CPPHTTPLIB_OPENSSL_SUPPORT)

target_compile_definitions(${PROJECT_NAME} PRIVATE
    GTPROXY_VERSION_MAJOR=${CMAKE_PROJECT_VERSION_MAJOR}
    GTPROXY_VERSION_MINOR=${CMAKE_PROJECT_VERSION_MINOR}
    GTPROXY_VERSION_PATCH=${CMAKE_PROJECT_VERSION_PATCH})

if (DEFINED GTPROXY_BUILD_VERSION AND NOT GTPROXY_BUILD_VERSION STREQUAL "")
    target_compile_definitions(${PROJECT_NAME} PRIVATE
        GTPROXY_BUILD_VERSION=${GTPROXY_BUILD_VERSION})
endif ()

set(GTPROXY_LICENSE_SERVER "" CACHE STRING "License server URL, e.g. https://keys.example.com (empty: license check disabled)")
set(GTPROXY_LICENSE_PUBLIC_KEY "" CACHE STRING "License server Ed25519 public key as 64 hex characters")

if (NOT GTPROXY_LICENSE_SERVER STREQUAL "" AND NOT GTPROXY_LICENSE_PUBLIC_KEY STREQUAL "")
    string(LENGTH "${GTPROXY_LICENSE_PUBLIC_KEY}" GTPROXY_LICENSE_PUBLIC_KEY_LENGTH)
    if (NOT GTPROXY_LICENSE_PUBLIC_KEY MATCHES "^[0-9a-fA-F]+$" OR NOT GTPROXY_LICENSE_PUBLIC_KEY_LENGTH EQUAL 64)
        message(FATAL_ERROR "GTPROXY_LICENSE_PUBLIC_KEY must be 64 hex characters")
    endif ()

    if (NOT GTPROXY_LICENSE_SERVER MATCHES "^https?://[^/]")
        message(FATAL_ERROR "GTPROXY_LICENSE_SERVER must be an http:// or https:// URL")
    endif ()

    if (GTPROXY_LICENSE_SERVER MATCHES "^http://")
        message(WARNING "GTPROXY_LICENSE_SERVER uses plain http://, license keys will be sent unencrypted. Use https:// for builds you hand out.")
    endif ()

    target_compile_definitions(${PROJECT_NAME} PRIVATE
        "GTPROXY_LICENSE_SERVER=\"${GTPROXY_LICENSE_SERVER}\""
        "GTPROXY_LICENSE_PUBLIC_KEY=\"${GTPROXY_LICENSE_PUBLIC_KEY}\"")
    message(STATUS "License check enabled (server: ${GTPROXY_LICENSE_SERVER})")
elseif (NOT GTPROXY_LICENSE_SERVER STREQUAL "" OR NOT GTPROXY_LICENSE_PUBLIC_KEY STREQUAL "")
    message(FATAL_ERROR "Set both GTPROXY_LICENSE_SERVER and GTPROXY_LICENSE_PUBLIC_KEY, or neither")
else ()
    message(STATUS "License check disabled")
endif ()

if (NOT DEFINED CMAKE_BUILD_TYPE OR CMAKE_BUILD_TYPE STREQUAL "" OR CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_definitions(${PROJECT_NAME} PRIVATE
        GTPROXY_DEBUG)
endif ()

add_custom_command(
    TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_SOURCE_DIR}/resources"
    "$<TARGET_FILE_DIR:${PROJECT_NAME}>/resources"
    COMMENT "Copying ${CMAKE_SOURCE_DIR}/resources to $<TARGET_FILE_DIR:${PROJECT_NAME}>/resources.")

file(GLOB SCRIPT_FILES "${CMAKE_SOURCE_DIR}/scripts/*.lua")
file(GLOB_RECURSE SCRIPT_SUBDIR_FILES "${CMAKE_SOURCE_DIR}/scripts/**/*.lua")

list(FILTER SCRIPT_FILES EXCLUDE REGEX "test_.*\\.lua$")
list(FILTER SCRIPT_SUBDIR_FILES EXCLUDE REGEX "test_.*\\.lua$")

foreach (script_file ${SCRIPT_FILES} ${SCRIPT_SUBDIR_FILES})
    get_filename_component(script_name "${script_file}" NAME)
    add_custom_command(
        TARGET ${PROJECT_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${script_file}"
        "$<TARGET_FILE_DIR:${PROJECT_NAME}>/scripts/${script_name}"
        COMMENT "Copying ${script_name} to $<TARGET_FILE_DIR:${PROJECT_NAME}>/scripts/")
endforeach ()
