# 🐨 KoalaScrape

**KoalaScrape** is a powerful, modern, and easy-to-use web scraper extension for Google Chrome. It allows you to visually select data elements on any webpage, automatically crawl through pagination, and export clean, structured data in multiple formats.

## ✨ Features

*   **🎯 Visual Selection:** Simply click on an element (like a product title) and KoalaExtract automatically detects and selects all similar items on the page.
*   **🚀 Auto-Pagination:** Set the "Next" button and let the scraper automatically navigate through multiple pages, collecting data as it goes.
*   **🔍 Live Preview:** View your scraped data in real-time within the side panel or open a full-page tabular preview for better analysis.
*   **💾 Flexible Export:** Download your data instantly as **CSV**, **JSON**, or **Excel**.
*   **🤖 Smart Extraction:** Automatically detects prices, emails, links, and images to structure your data intelligently.
*   **🎨 Dark Mode UI:** A clean, modern interface designed for ease of use.

## 📥 Installation

1.  Clone or download this repository.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable **"Developer mode"** in the top right corner.
4.  Click **"Load unpacked"**.
5.  Select the folder containing this extension's files.
6.  The **KoalaScrape** icon should appear in your toolbar.

## 📖 How to Use

### 1. Scrape a Single Page
1.  Navigate to the website you want to scrape.
2.  Click the extension icon to open the **Side Panel**.
3.  Click **"Start Selection"**.
4.  Hover over the data you want to capture (e.g., a card component) and click it.
5.  The extension will highlight all matching items and populate the preview table.

### 2. Scrape Multiple Pages
1.  After selecting your data, click **"Set Next Button"** in the side panel.
2.  Click the "Next" or ">" arrow button on the webpage pagination.
3.  Enter the number of pages you want to scrape (e.g., `5`).
4.  Click **"Auto Scrape"**.
5.  Sit back and watch as the extension navigates and collects data!

### 3. Export Data
1.  Once you have collected your data, verify it in the **Preview** section.
2.  Click **"Open Full Preview"** for a detailed view in a new tab.
3.  Click **CSV**, **JSON**, or **Excel** to download your dataset.

## 🛠️ Data Handling
Data is processed locally in your browser. Large datasets are handled efficiently using background processing and proper deduplication logic.

## 📝 License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
