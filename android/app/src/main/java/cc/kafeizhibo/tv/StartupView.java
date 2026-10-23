package cc.kafeizhibo.tv;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Button;

final class StartupView extends LinearLayout {
    private final TextView status;
    private final Button retryButton;
    StartupView(Context context, final Runnable retry) {
        super(context); setOrientation(VERTICAL); setGravity(Gravity.CENTER); setBackgroundColor(Color.rgb(16, 20, 23));
        TextView logo = new TextView(context); logo.setText("K"); logo.setTextColor(Color.WHITE); logo.setTextSize(36); logo.setGravity(Gravity.CENTER); logo.setTypeface(Typeface.DEFAULT, Typeface.BOLD); logo.setBackgroundColor(Color.rgb(231, 107, 73));
        addView(logo, new LayoutParams(92, 92));
        ProgressBar ring = new ProgressBar(context); addView(ring, new LayoutParams(46, 46));
        status = new TextView(context); status.setTextColor(Color.LTGRAY); status.setTextSize(16); status.setGravity(Gravity.CENTER); status.setText("正在准备直播服务"); LayoutParams statusParams = new LayoutParams(-2, -2); statusParams.topMargin = 22; addView(status, statusParams);
        TextView version = new TextView(context); version.setTextColor(Color.GRAY); version.setTextSize(12); version.setText("体育直播 0.1.0"); LayoutParams versionParams = new LayoutParams(-2, -2); versionParams.topMargin = 8; addView(version, versionParams);
        retryButton = new Button(context); retryButton.setText("重试"); retryButton.setTextColor(Color.WHITE); retryButton.setVisibility(INVISIBLE); retryButton.setOnClickListener(view -> retry.run()); LayoutParams retryParams = new LayoutParams(-2, -2); retryParams.topMargin = 18; addView(retryButton, retryParams);
    }
    void setStatus(String value, boolean progress) { status.setText(value); retryButton.setVisibility(progress ? INVISIBLE : VISIBLE); if (!progress) retryButton.requestFocus(); }
    void pauseAnimation() { }
    void resumeAnimation() { }
}
