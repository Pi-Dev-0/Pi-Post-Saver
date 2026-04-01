<p align="center">
  <img src="images/logo.png" width="100" alt="Pi Post Saver Logo">
  <h1 align="center">Pi Post Saver</h1>
  <p align="center">
    <strong>The ultimate tool for downloading high-quality content from Facebook and Instagram.</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-0.1.4-blue?style=for-the-badge" alt="Version">
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/Built%20With-React-61DAFB?style=for-the-badge&logo=react" alt="React">
  <img src="https://img.shields.io/badge/Platform-Brave%20%7C%20Chrome-orange?style=for-the-badge" alt="Platforms">
</p>

---

## 🌟 Overview

**Social Post Downloader** is a modern, privacy-focused browser extension designed to help you save your favorite memories and media from social platforms. Whether it's a stunning photo on Instagram, a funny video on Facebook, or a fleeting Story, our extension makes downloading seamless and fast.

![Preview](images/preview.png)

### 🎥 Demonstration Video

https://github.com/Pi-Dev-0/Facebook-Post-Downloader/raw/main/images/Instagram_Download_Demo.mp4

## ✨ Key Features


- 📸 **Ultra HD Media**: Automatically detects and downloads the highest resolution available for images.
- 🎥 **Universal Video Downloader**: Supports Reels, standard video posts, Stories, and IGTV.
- 📖 **Story Manager**: A centralized dashboard to view, select, and batch-download stories from your feed.
- 📦 **One-Click Batching**: No more manual right-clicking. Select dozens of posts and download them in a single zipped batch (if supported) or sequential queue.
- 🧠 **Advanced Media Detection**: Uses real-time network interception (GraphQL & Fetch API patching) to find hidden media sources that other extensions miss.
- 🎨 **Premium Aesthetic**: Beautifully designed UI with glassmorphism, smooth animations, and a sleek dark mode.
- 🔒 **Local & Private**: No cloud processing. Your data stays on your machine.
- 🛠 **Browser Integration**: Injectable buttons that feel like native parts of Facebook and Instagram.


## 🚀 Installation & Setup

You can install this extension on any **Chromium-based browser** (Brave, Chrome, Edge, Opera, Vivaldi, etc.) by following these simple steps:

### 1️⃣ Download the Extension
You can get the source code in two ways:
*   **Via Git (Recommended for updates)**:
    ```bash
    git clone https://github.com/rashidsahriar/Facebook-Post-Downloader.git
    ```
*   **Direct Download**:
    - Click the green **Code** button at the top of this repository.
    - Select **Download ZIP**.
    - Extract the ZIP file to a folder on your computer.

### 2️⃣ Enable Developer Mode
1.  Open your browser and navigate to the Extensions page:
    *   **Brave**: `brave://extensions`
    *   **Chrome**: `chrome://extensions`
    *   **Edge**: `edge://extensions`
2.  In the top right corner, find the **Developer mode** toggle and turn it **ON**.

### 3️⃣ Load the Extension
1.  Click the **Load unpacked** button (usually appears in the top left after enabling Developer Mode).
2.  A file picker will open. Navigate to the folder where you cloned or extracted the extension.
3.  Select the **root folder** (the one containing `manifest.json`) and click **Open/Select**.

### 4️⃣ Verify & Start
- You should now see **Social Post Downloader** in your extension list!
- Head over to [Facebook](https://facebook.com) or [Instagram](https://instagram.com).
- **Pro Tip**: Refresh the page if you were already on it to activate the downloader!


## 📖 Usage Guide

### Downloading Posts
Hover over any post on Facebook or Instagram. You'll see a sleek "Download" button floating or integrated near the action buttons (Like/Share). Click it to save the media immediately.

### Downloading Stories
1. Click the **Social Post Downloader** icon in your browser toolbar to open the Story Manager.
2. The manager will list all detected stories from your current session.
3. Select the stories you want to save.
4. Click **Download Selected** to save them to your computer.

## 🛠 Tech Stack

- **Frontend**: [React](https://reactjs.org/) for the dynamic UI.
- **Background Layer**: Chrome Extension Manifest V3.
- **Injection**: Pure JavaScript content scripts for seamless integration.

## 📜 License

This project is licensed under the **MIT License**.

> [!NOTE]
> This is a modified and improved version of the original [facebook-post-downloader](https://github.com/ijunle/facebook-post-downloader).
> Improved by **Rashid Sahriar**.

---

<p align="center">
  Made with ❤️ By Rashid Sahriar ASIF.
</p>

