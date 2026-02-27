import { chromium } from "playwright"

import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  CITY,
  STREET,
  HOUSE,
  SHUTDOWNS_PAGE,
} from "./constants.js"

import {
  capitalize,
  deleteLastMessage,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
} from "./helpers.js"

async function getInfo() {
  console.log("🌀 Getting info...")

  const browser = await chromium.launch({ headless: true })
  const browserPage = await browser.newPage()

  try {
    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
      timeout: 60000, // Збільшимо таймаут до 60с, бо сайт ДТЕК буває повільним
    })

    const csrfTokenTag = await browserPage.waitForSelector(
      'meta[name="csrf-token"]',
      { state: "attached" }
    )
    const csrfToken = await csrfTokenTag.getAttribute("content")

    const info = await browserPage.evaluate(
      async ({ CITY, STREET, csrfToken }) => {
        const formData = new URLSearchParams()
        formData.append("method", "getHomeNum")
        // formData.append("data[0][name]", "city")
        // formData.append("data[0][value]", CITY)
        formData.append("data[0][name]", "street")
        formData.append("data[0][value]", STREET)
        formData.append("data[1][name]", "updateFact")
        formData.append("data[1][value]", new Date().toLocaleString("uk-UA"))

        const response = await fetch("/ua/ajax", {
          method: "POST",
          headers: {
            "x-requested-with": "XMLHttpRequest",
            "x-csrf-token": csrfToken,
          },
          body: formData,
        })
        return await response.json()
      },
      { CITY, STREET, csrfToken }
    )

    console.log("✅ Getting info finished.")
    return info
  } catch (error) {
    throw Error(`❌ Getting info failed: ${error.message}`)
  } finally {
    await browser.close()
  }
}

function checkIsOutage(info) {
  console.log("🌀 Checking power outage...")

  if (!info?.data) {
    // Якщо дані не прийшли, вважаємо що це помилка, а не відсутність відключення
    // Краще викинути помилку, щоб не видалити випадково файл повідомлення
    throw Error("❌ Power outage info missed or empty response.")
  }

  const { sub_type, start_date, end_date, type } = info?.data?.[HOUSE] || {}
  
  // Перевірка: чи є хоч якісь дані про відключення
  const isOutageDetected =
    (sub_type && sub_type !== "") || 
    (start_date && start_date !== "") || 
    (end_date && end_date !== "") || 
    (type && type !== "")

  isOutageDetected
    ? console.log("🚨 Power outage detected!")
    : console.log("⚡️ No power outage!")

  return isOutageDetected
}

function generateMessage(info) {
  console.log("🌀 Generating message...")

  const { sub_type, start_date, end_date } = info?.data?.[HOUSE] || {}
  const { updateTimestamp } = info || {}

  const reason = capitalize(sub_type)
  
  // ВИПРАВЛЕННЯ: Більше не обрізаємо дату через split(" ")[0]
  // trim() прибере зайві пробіли, якщо вони є
  const begin = start_date ? start_date.trim() : "Невідомо"
  const end = end_date ? end_date.trim() : "Невідомо"

  return [
    "⚡️ <b>За даними сайту ДТЕК зафіксовано:</b>",
    "",
    `⚠️ <i>${reason}</i>`,
    `🪫 <code>${begin} — ${end}</code>`,
    "",
    "🤖 <i>Це повідомлення оновлюється автоматично</i>",
    "",
    `🔄 <i>Оновлення на сайті: ${updateTimestamp}</i>`,
    `🕒 <i>Час перевірки: ${getCurrentTime()}</i>`,
  ].join("\n")
}

async function sendNotification(message) {
  if (!TELEGRAM_BOT_TOKEN)
    throw Error("❌ Missing telegram bot token or chat id.")
  if (!TELEGRAM_CHAT_ID) throw Error("❌ Missing telegram chat id.")

  console.log("🌀 Sending notification...")

  const lastMessage = loadLastMessage() || {}
  
  // Логіка проста: якщо message_id є — Telegram відредагує старе повідомлення.
  // Якщо немає — надішле нове.
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${
        lastMessage.message_id ? "editMessageText" : "sendMessage"
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          message_id: lastMessage.message_id ?? undefined,
        }),
      }
    )

    const data = await response.json()
    
    // Якщо Telegram каже, що повідомлення не змінилося (ми шлемо той самий текст),
    // він може повернути помилку, але це ок.
    if (!data.ok && data.description?.includes("message is not modified")) {
       console.log("🟡 Message content is the same, skipping update.")
       return
    }

    if (data.ok) {
        saveLastMessage(data.result)
        console.log("🟢 Notification sent/updated.")
    } else {
        console.error("🔴 Telegram API error:", data)
    }

  } catch (error) {
    console.log("🔴 Notification failed.", error.message)
    // Якщо сталася критична помилка відправки (наприклад, видалили повідомлення вручну),
    // можна видалити файл, щоб наступного разу надіслати нове.
    // deleteLastMessage()
  }
}

async function run() {
  const info = await getInfo()
  const isOutage = checkIsOutage(info)

  // Сценарій 1: Світло Є
  if (!isOutage) {
    const lastMessage = loadLastMessage()
    
    // Якщо у нас зберігся файл про відключення, значить світло ТІЛЬКИ ЩО дали
    if (lastMessage) {
        console.log("💚 Power restored! Deleting previous outage message...")
        
        // Видаляємо повідомлення про відключення
        try {
            if (lastMessage.message_id) {
                await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: TELEGRAM_CHAT_ID,
                        message_id: lastMessage.message_id
                    })
                })
                console.log("🗑️ Message deleted successfully.")
            }
        } catch (error) {
            console.error("🔴 Failed to delete message:", error.message)
        }
        
        // Тепер можна видаляти файл.
        // Наступне відключення прийде новим повідомленням.
        deleteLastMessage()
    } else {
        // Світла нема, файлу нема — все стабільно добре, нічого не робимо
        console.log("✅ Stable power supply. No action needed.")
    }
    return
  }

  // Сценарій 2: Світла НЕМАЄ (isOutage = true)
  if (isOutage) {
    const message = generateMessage(info)
    await sendNotification(message)
  }
}

run().catch((error) => console.error(error.message))
