import email
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.imap_sync import _decode_header_value, _get_body, _strip_dangerous_tags


# ── _decode_header_value ─────────────────────────────────────────────────────


def test_decode_plain_ascii():
    assert _decode_header_value("Hello World") == "Hello World"


def test_decode_rfc2047_base64_utf8():
    # "=?utf-8?b?SMOpbGxv?=" decodes to "Héllo"
    result = _decode_header_value("=?utf-8?b?SMOpbGxv?=")
    assert "llo" in result


def test_decode_rfc2047_quoted_printable():
    # Contains "nsubscribe" after decoding
    result = _decode_header_value("=?iso-8859-1?q?=DCnsubscribe?=")
    assert "nsubscribe" in result


def test_decode_multiple_encoded_words():
    result = _decode_header_value("=?utf-8?b?Rmlyc3Q=?= =?utf-8?b?U2Vjb25k?=")
    assert "First" in result
    assert "Second" in result


def test_decode_empty_string():
    assert _decode_header_value("") == ""


def test_decode_none_fallback():
    result = _decode_header_value(None)
    assert result == ""


# ── _strip_dangerous_tags ────────────────────────────────────────────────────


def test_strip_removes_script_tags():
    result = _strip_dangerous_tags("<p>hi</p><script>alert(1)</script>")
    assert "<script" not in result


def test_strip_removes_script_content():
    result = _strip_dangerous_tags("<script>alert(1)</script>")
    assert "alert(1)" not in result


def test_strip_removes_form_tags():
    result = _strip_dangerous_tags("<form action='/steal'><input></form>")
    assert "<form" not in result


def test_strip_removes_input_tags():
    result = _strip_dangerous_tags("<input type='text' value='x'>")
    assert "<input" not in result


def test_strip_removes_button_tags():
    result = _strip_dangerous_tags("<button onclick='evil()'>click</button>")
    assert "<button" not in result


def test_strip_removes_onerror_attr():
    result = _strip_dangerous_tags('<img src="cat.jpg" onerror="evil()">')
    assert "onerror" not in result


def test_strip_removes_onclick_attr():
    result = _strip_dangerous_tags('<a href="#" onclick="evil()">link</a>')
    assert "onclick" not in result


def test_strip_removes_onload_on_body():
    result = _strip_dangerous_tags('<body onload="evil()"><p>hi</p></body>')
    assert "onload" not in result


def test_strip_case_insensitive_onClick():
    result = _strip_dangerous_tags('<a onClick="x()">link</a>')
    assert "onclick" not in result.lower()
    result2 = _strip_dangerous_tags('<img ONMOUSEOVER="x()">')
    assert "onmouseover" not in result2.lower()


def test_strip_preserves_href():
    result = _strip_dangerous_tags('<a href="http://example.com">link</a>')
    assert 'href="http://example.com"' in result or "href" in result


def test_strip_preserves_src_on_img():
    result = _strip_dangerous_tags('<img src="cat.jpg">')
    assert "cat.jpg" in result


def test_strip_preserves_text_content():
    # Text inside stripped tags is removed with the tag
    result = _strip_dangerous_tags("<script>some text</script>")
    assert "some text" not in result


def test_strip_preserves_safe_html():
    html = "<p>text</p><strong>bold</strong><em>italic</em><ul><li>item</li></ul>"
    result = _strip_dangerous_tags(html)
    assert "<p>" in result
    assert "<strong>" in result
    assert "<em>" in result
    assert "<ul>" in result
    assert "<li>" in result


def test_strip_handles_empty_string():
    assert _strip_dangerous_tags("") == ""


def test_strip_nested_script():
    result = _strip_dangerous_tags("<div><script>evil()</script></div>")
    assert "<script" not in result
    assert "evil()" not in result


# ── _get_body ────────────────────────────────────────────────────────────────


def test_get_body_simple_html():
    msg = MIMEText("<p>hello</p>", "html")
    html, text = _get_body(msg)
    assert html is not None
    assert "<p>hello</p>" in html
    assert text is None


def test_get_body_simple_text():
    msg = MIMEText("hello plain", "plain")
    html, text = _get_body(msg)
    assert html is None
    assert text is not None
    assert "hello plain" in text


def test_get_body_multipart_extracts_both():
    msg = MIMEMultipart("alternative")
    msg.attach(MIMEText("plain text", "plain"))
    msg.attach(MIMEText("<p>html</p>", "html"))
    html, text = _get_body(msg)
    assert html is not None
    assert text is not None


def test_get_body_multipart_prefers_first_html():
    msg = MIMEMultipart("mixed")
    msg.attach(MIMEText("<p>first</p>", "html"))
    msg.attach(MIMEText("<p>second</p>", "html"))
    html, text = _get_body(msg)
    assert "first" in html
    assert "second" not in html


def test_get_body_skips_attachments():
    msg = MIMEMultipart("mixed")
    attachment = MIMEText("<p>attached</p>", "html")
    attachment.add_header("Content-Disposition", "attachment", filename="file.html")
    msg.attach(attachment)
    html, text = _get_body(msg)
    assert html is None


def test_get_body_empty_multipart():
    msg = MIMEMultipart("alternative")
    html, text = _get_body(msg)
    assert html is None
    assert text is None


def test_get_body_unknown_content_type():
    msg = MIMEMultipart("mixed")
    cal = MIMEText("BEGIN:VCALENDAR", "calendar")
    msg.attach(cal)
    html, text = _get_body(msg)
    assert html is None
    assert text is None
