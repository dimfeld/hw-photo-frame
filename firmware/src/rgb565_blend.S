// Blend eight RGB565 pixels per iteration with the ESP32-S3's 128-bit PIE unit.

.text
.align 4
.literal_position
.literal .LC_red_mask, 0xf800f800
.literal .LC_green_mask, 0x07e007e0
.literal .LC_blue_mask, 0x001f001f

.global blend_rgb565_simd
.type blend_rgb565_simd, @function
.align 4
blend_rgb565_simd:
    // a2: output, a3: from, a4: target, a5: pixels, a6: alpha, a7: inverse
    entry a1, 32

    // Constants are kept in the aligned stack frame so broadcast loads can fill
    // all eight 16-bit lanes. The three masks operate on pairs of RGB565 pixels.
    s16i a6, a1, 0
    s16i a7, a1, 2
    movi.n a8, 1
    s16i a8, a1, 4
    movi a8, 128
    s16i a8, a1, 6
    l32r a8, .LC_red_mask
    s32i.n a8, a1, 8
    l32r a8, .LC_green_mask
    s32i.n a8, a1, 12
    l32r a8, .LC_blue_mask
    s32i.n a8, a1, 16

    mov.n a8, a1
    ee.vldbc.16.ip q4, a8, 2
    ee.vldbc.16 q5, a8
    addi.n a9, a1, 8
    addi.n a10, a1, 12
    addi.n a11, a1, 16
    addi.n a12, a1, 4
    addi.n a13, a1, 6
    movi.n a14, 8
    srli a5, a5, 3
    loopnez a5, .Lblend_end
.Lblend:
    ee.vld.128.ip q0, a3, 16
    ee.vld.128.ip q1, a4, 16

    // Red: isolate bits 11..15 in each 16-bit lane, then normalize them.
    ee.vldbc.32 q6, a9
    ee.andq q2, q0, q6
    ee.andq q3, q1, q6
    ee.vldbc.16 q6, a12
    movi.n a15, 11
    wsr.sar a15
    ee.vmul.u16 q2, q2, q6
    ee.vmul.u16 q3, q3, q6
    ee.vldbc.16 q6, a13
    ee.mov.u16.qacc q6
    ee.vmulas.u16.qacc q2, q5
    ee.vmulas.u16.qacc q3, q4
    ee.srcmb.s16.qacc q7, a14, 0
    wsr.sar a15
    ee.vsl.32 q7, q7

    // Green: isolate bits 5..10 and blend the eight channel values.
    ee.vldbc.32 q6, a10
    ee.andq q2, q0, q6
    ee.andq q3, q1, q6
    ee.vldbc.16 q6, a12
    movi.n a15, 5
    wsr.sar a15
    ee.vmul.u16 q2, q2, q6
    ee.vmul.u16 q3, q3, q6
    ee.vldbc.16 q6, a13
    ee.mov.u16.qacc q6
    ee.vmulas.u16.qacc q2, q5
    ee.vmulas.u16.qacc q3, q4
    ee.srcmb.s16.qacc q2, a14, 0
    wsr.sar a15
    ee.vsl.32 q2, q2
    ee.orq q7, q7, q2

    // Blue is already in the low five bits of each 16-bit lane.
    ee.vldbc.32 q6, a11
    ee.andq q2, q0, q6
    ee.andq q3, q1, q6
    ee.vldbc.16 q6, a13
    ee.mov.u16.qacc q6
    ee.vmulas.u16.qacc q2, q5
    ee.vmulas.u16.qacc q3, q4
    ee.srcmb.s16.qacc q2, a14, 0
    ee.orq q7, q7, q2
    ee.vst.128.ip q7, a2, 16
.Lblend_end:
    retw.n

.size blend_rgb565_simd, .-blend_rgb565_simd
