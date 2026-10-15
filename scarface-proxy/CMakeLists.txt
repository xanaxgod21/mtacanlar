set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# CMake Conan requires this to be set or passed in via the command line
set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/cmake-conan/conan_provider.cmake)

cmake_minimum_required(VERSION 3.24)

# Statically link the MSVC runtime (/MT) so the exe needs no Visual C++
# redistributable on the machines it runs on. cmake-conan reads this variable
# and builds every Conan dependency with compiler.runtime=static to match, so
# the whole exe is self-contained (set before project() so the Conan provider,
# which runs during project(), picks it up).
if (MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif ()

project(ScarfaceProxy VERSION 3.0.0)

add_subdirectory(lib)
add_subdirectory(src)

enable_testing()
add_subdirectory(tests)
