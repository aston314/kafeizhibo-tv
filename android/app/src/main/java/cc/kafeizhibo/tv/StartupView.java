package cc.kafeizhibo.tv;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.animation.Animation;
import android.view.animation.LinearInterpolator;
import android.view.animation.RotateAnimation;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

final class StartupView extends LinearLayout {
    private final TextView status;
    private final Button retryButton;
    private final ImageView ring;
    private final Animation ringRotation;
    private boolean loading = true;

    StartupView(Context context, final Runnable retry) {
        super(context);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setBackgroundColor(Color.rgb(15, 18, 20));

        FrameLayout logoBlock = new FrameLayout(context);
        logoBlock.setFocusable(false);
        addView(logoBlock, new LayoutParams(dp(136), dp(136)));

        ring = new ImageView(context);
        ring.setImageResource(R.drawable.startup_ring);
        ring.setScaleType(ImageView.ScaleType.FIT_CENTER);
        ring.setFocusable(false);
        ring.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        logoBlock.addView(ring, new FrameLayout.LayoutParams(-1, -1, Gravity.CENTER));

        ImageView logo = new ImageView(context);
        logo.setImageResource(R.drawable.ic_launcher);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setFocusable(false);
        logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        logoBlock.addView(logo, new FrameLayout.LayoutParams(dp(88), dp(88), Gravity.CENTER));

        ringRotation = new RotateAnimation(0, 360, Animation.RELATIVE_TO_SELF, 0.5f, Animation.RELATIVE_TO_SELF, 0.5f);
        ringRotation.setDuration(1100);
        ringRotation.setInterpolator(new LinearInterpolator());
        ringRotation.setRepeatCount(Animation.INFINITE);

        status = new TextView(context);
        status.setTextColor(Color.rgb(241, 243, 242));
        status.setTextSize(24);
        status.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        status.setGravity(Gravity.CENTER);
        status.setMaxLines(2);
        status.setText(context.getString(R.string.startup_status, context.getString(R.string.app_name)));
        LayoutParams statusParams = new LayoutParams(-2, -2);
        statusParams.topMargin = dp(20);
        addView(status, statusParams);

        TextView version = new TextView(context);
        version.setTextColor(Color.rgb(174, 183, 186));
        version.setTextSize(14);
        version.setGravity(Gravity.CENTER);
        version.setText(context.getString(R.string.startup_version, context.getString(R.string.app_version)));
        LayoutParams versionParams = new LayoutParams(-2, -2);
        versionParams.topMargin = dp(8);
        addView(version, versionParams);

        retryButton = new Button(context);
        retryButton.setText("重试");
        retryButton.setTextColor(Color.WHITE);
        retryButton.setVisibility(INVISIBLE);
        retryButton.setOnClickListener(view -> retry.run());
        LayoutParams retryParams = new LayoutParams(-2, -2);
        retryParams.topMargin = dp(18);
        addView(retryButton, retryParams);
        resumeAnimation();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    void setStatus(String value, boolean progress) {
        status.setText(value);
        loading = progress;
        ring.setVisibility(progress ? VISIBLE : INVISIBLE);
        retryButton.setVisibility(progress ? INVISIBLE : VISIBLE);
        if (progress) resumeAnimation();
        else pauseAnimation();
        if (!progress) retryButton.requestFocus();
    }

    void pauseAnimation() { ring.clearAnimation(); }

    void resumeAnimation() {
        if (loading && ring.getAnimation() == null) ring.startAnimation(ringRotation);
    }
}
