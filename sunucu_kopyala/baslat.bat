@echo off
rem Cift tiklayarak calistirmak icin: baslat.ps1'i calistirir.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0baslat.ps1" %*
pause
