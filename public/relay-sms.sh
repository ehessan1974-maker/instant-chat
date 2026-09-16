#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# بوابة رسائل الموبايل — تطبيق «محادثة فورية»
# يسحب رموز الدخول المنتظرة من سيرفرك ويرسلها SMS من شريحة هذا الموبايل
# (تُستهلك من باقة رسائلك — بلا أي تكلفة إضافية على مزودين خارجيين)
#
# التشغيل على Termux (أندرويد):
#   1) ثبّت تطبيقَي Termux و Termux:API من F-Droid (نسخ متطابقة!)
#   2) في Termux:
#        pkg update -y && pkg install -y termux-api jq curl
#      ثم افتح هذا الملف: nano relay-sms.sh وعدّل السطرين BASE و TOKEN
#        chmod +x relay-sms.sh
#   3) اسمح بصلاحية الرسائل عند أول إرسال (Termux:API)
#   4) شغّله:  ./relay-sms.sh
#      ولإبقائه شغالاً بالخلفية مع قفل الاستيقاظ:
#        termux-wake-lock && nohup ./relay-sms.sh > relay.log 2>&1 &
# ============================================================

# ⚙️ عدّل هذين السطرين (أو مرّر التوكن كمتغير بيئة: SMS_RELAY_TOKEN=xxx ./relay-sms.sh):
BASE="https://instant-chat-f2ac.onrender.com"   # عنوان سيرفرك
TOKEN="${SMS_RELAY_TOKEN:-ضع_رمز_SMS_RELAY_TOKEN_هنا}"   # نفس قيمة SMS_RELAY_TOKEN على Render

POLL_SECONDS=5
LIMIT=5

if [ -z "${SMS_RELAY_TOKEN:-}" ] || [ "$TOKEN" = "ضع_رمز_SMS_RELAY_TOKEN_هنا" ]; then
  echo "[relay] ⚠️ رمز البوابة مفقود — شغّله هكذا:"
  echo "        SMS_RELAY_TOKEN='رمزك_من_صفحة_التفعيل' bash relay.sh"
  exit 1
fi

echo "[relay] بوابة الرسائل تعمل — السحب كل ${POLL_SECONDS} ثانية من ${BASE}"

while true; do
  # سحب الرسائل المنتظرة
  RESPONSE=$(curl -s --max-time 15 \
    -H "Authorization: Bearer ${TOKEN}" \
    "${BASE}/api/sms/relay/pending?limit=${LIMIT}" 2>/dev/null)

  if echo "$RESPONSE" | jq -e '.messages' >/dev/null 2>&1; then
    # رسائل مكتملة الصيغة — نعالجها واحدة واحدة
    while IFS= read -r MSG; do
      ID=$(echo "$MSG" | jq -r '.id')
      TO=$(echo "$MSG" | jq -r '.phone')
      TEXT=$(echo "$MSG" | jq -r '.text')
      echo "[relay] إرسال إلى ${TO} ..."
      if termux-sms-send -n "$TO" "$TEXT" 2>/dev/null; then
        OK=true; ERR=""
        echo "[relay] ✓ أُرسلت (${ID})"
      else
        OK=false; ERR="termux_send_failed"
        echo "[relay] ✗ فشل الإرسال (${ID})"
      fi
      # تثبيت النتيجة على السيرفر
      PAYLOAD=$(jq -n --arg id "$ID" --argjson ok "$OK" --arg err "$ERR" \
        '{results:[{id:$id, ok:$ok, error:$err}]}')
      curl -s --max-time 15 -X POST \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" "${BASE}/api/sms/relay/confirm" >/dev/null
    done <<< "$(echo "$RESPONSE" | jq -c '.messages[]?')"
  fi

  sleep "$POLL_SECONDS"
done
