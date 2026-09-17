package com.searvator.ibsrunner;

import android.animation.ValueAnimator;
import android.view.MotionEvent;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.OvershootInterpolator;

/**
 * Small animation helpers.
 *
 * The point of these is not decoration. A runner on a noisy road with gloves on needs to
 * know instantly that his tap registered - otherwise he taps again, and again. So every
 * button visibly squashes the moment it is touched, and every state change slides rather
 * than snapping, which makes the screen feel like it is keeping up with him.
 */
public class Anim {

    /** Press feedback: the view scales down under the finger and springs back on release. */
    public static void press(final View v) {
        if (v == null) return;
        v.setOnTouchListener((view, e) -> {
            switch (e.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    view.animate().scaleX(0.96f).scaleY(0.96f).alpha(0.9f)
                            .setDuration(90).setInterpolator(new DecelerateInterpolator()).start();
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    view.animate().scaleX(1f).scaleY(1f).alpha(1f)
                            .setDuration(160).setInterpolator(new OvershootInterpolator(2.2f)).start();
                    if (e.getAction() == MotionEvent.ACTION_UP) view.performClick();
                    break;
            }
            return true;
        });
    }

    /** Applies press feedback to a whole group of views in one line. */
    public static void press(View... views) {
        for (View v : views) press(v);
    }

    /** Fades and lifts a card into place - used when a job card first appears. */
    public static void enter(View v, long delayMs) {
        if (v == null) return;
        v.setAlpha(0f);
        v.setTranslationY(24f);
        v.animate().alpha(1f).translationY(0f)
                .setStartDelay(delayMs).setDuration(260)
                .setInterpolator(new DecelerateInterpolator()).start();
    }

    public static void enter(View v) { enter(v, 0); }

    /** Show or hide without the layout snapping. */
    public static void show(View v, boolean visible) {
        if (v == null) return;
        boolean already = v.getVisibility() == View.VISIBLE;
        if (visible == already) return;
        if (visible) {
            v.setVisibility(View.VISIBLE);
            v.setAlpha(0f);
            v.animate().alpha(1f).setDuration(200).start();
        } else {
            v.animate().alpha(0f).setDuration(150)
                    .withEndAction(() -> v.setVisibility(View.GONE)).start();
        }
    }

    /** A soft pulse, used on the live job card so the eye keeps finding it. */
    public static ValueAnimator pulse(final View v) {
        if (v == null) return null;
        ValueAnimator a = ValueAnimator.ofFloat(1f, 1.015f, 1f);
        a.setDuration(1600);
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.setInterpolator(new AccelerateDecelerateInterpolator());
        a.addUpdateListener(an -> {
            float s = (float) an.getAnimatedValue();
            v.setScaleX(s);
            v.setScaleY(s);
        });
        a.start();
        return a;
    }

    /** Counts a number up instead of jumping to it - used for km and trip counts. */
    public static void countTo(final android.widget.TextView t, final float from, final float to, final String suffix, final boolean oneDecimal) {
        if (t == null) return;
        ValueAnimator a = ValueAnimator.ofFloat(from, to);
        a.setDuration(500);
        a.setInterpolator(new DecelerateInterpolator());
        a.addUpdateListener(an -> {
            float v = (float) an.getAnimatedValue();
            t.setText(oneDecimal
                    ? String.format(java.util.Locale.US, "%.1f", v) + suffix
                    : String.valueOf((int) v) + suffix);
        });
        a.start();
    }
}
