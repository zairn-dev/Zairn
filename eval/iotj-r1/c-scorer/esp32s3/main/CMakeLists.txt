# The scorer is compiled from the shared source one level up, unchanged.
idf_component_register(SRCS "main.c" "../../trust_scorer.c"
                       INCLUDE_DIRS "../.."
                       REQUIRES esp_driver_usb_serial_jtag esp_partition esp_timer)
target_compile_options(${COMPONENT_LIB} PRIVATE -ffp-contract=off)
